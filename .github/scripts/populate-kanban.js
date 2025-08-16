const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");

const token = process.env.PROJECTS_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = process.env.OWNER;
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
const TASKS_DIR = process.env.TASKS_DIR || "tasks";
const RELATIONSHIP_HEADER = process.env.RELATIONSHIP_HEADER || "Relationships";
const COMMENT_HEADER = process.env.COMMENT_HEADER || "Automated Notes";

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

const mdToBool = v => typeof v === "string" ? v.trim().length > 0 : !!v;

// ---------- GraphQL helpers ----------

async function getProjectNode() {
  const orgQ = `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id title }}}`;
  const userQ = `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title }}}`;
  const asOrg = await octokit.graphql(orgQ, { login: OWNER, number: PROJECT_NUMBER }).catch(()=>null);
  if (asOrg?.organization?.projectV2) return asOrg.organization.projectV2;
  const asUser = await octokit.graphql(userQ, { login: OWNER, number: PROJECT_NUMBER }).catch(()=>null);
  if (asUser?.user?.projectV2) return asUser.user.projectV2;
  throw new Error(`Project v2 #${PROJECT_NUMBER} not found for ${OWNER}`);
}

async function getProjectFields(projectId) {
  const q = `
    query($projectId:ID!){
      node(id:$projectId){
        ... on ProjectV2 {
          fields(first:100){
            nodes{
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options{ id name } }
            }
          }
        }
      }
    }`;
  const res = await octokit.graphql(q, { projectId });
  const fields = res.node.fields.nodes;
  const map = new Map(fields.map(f => [f.name, f]));
  return { fields, map };
}

async function addIssueToProject(projectId, issueNodeId) {
  const m = `
    mutation($projectId:ID!,$contentId:ID!){
      addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}){
        item{ id }
      }
    }`;
  const res = await octokit.graphql(m, { projectId, contentId: issueNodeId });
  return res.addProjectV2ItemById.item.id;
}

async function setFieldValue({ projectId, itemId, field, value }) {
  if (!field) return;
  const base = { projectId, itemId, fieldId: field.id };
  let val = null;

  switch (field.dataType) {
    case "SINGLE_SELECT": {
      const opt = field.options.find(o => o.name.toLowerCase() === String(value).trim().toLowerCase());
      if (!opt) return;
      val = { singleSelectOptionId: opt.id };
      break;
    }
    case "NUMBER": {
      const n = Number(value);
      if (Number.isNaN(n)) return;
      val = { number: n };
      break;
    }
    case "DATE": {
      const s = String(value).trim();
      if (!s) return;
      val = { date: s }; // YYYY-MM-DD
      break;
    }
    case "TEXT": {
      const s = String(value ?? "").trim();
      if (!s) return;
      val = { text: s };
      break;
    }
    default:
      return;
  }

  const m = `
    mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:ProjectV2FieldValue!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:$value
      }){ projectV2Item{ id } }
    }`;
  await octokit.graphql(m, { ...base, value: val });
}

// ---------- Issue helpers ----------

function repoContext() { return github.context.repo; }

async function ensureLabels({ owner, repo, labels }) {
  if (!labels?.length) return;
  try {
    const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    const names = new Set(existing.map(l => l.name.toLowerCase()));
    for (const lb of labels) {
      if (!names.has(lb.toLowerCase())) {
        await octokit.rest.issues.createLabel({ owner, repo, name: lb });
      }
    }
  } catch { /* ignore create failures (race) */ }
}

async function setIssueBasics({ owner, repo, issueNumber, assignees, labels, milestoneTitle }) {
  if (labels?.length) await ensureLabels({ owner, repo, labels });
  let milestone = undefined;
  if (milestoneTitle) {
    const m = await octokit.rest.issues.listMilestones({ owner, repo, state: "open" });
    const found = m.data.find(mi => mi.title.toLowerCase() === milestoneTitle.toLowerCase());
    if (found) milestone = found.number;
  }
  await octokit.rest.issues.update({
    owner, repo, issue_number: issueNumber,
    assignees, labels, milestone
  });
}

async function findOrCreateIssue({ owner, repo, filePath, fmTitle, body, existingIssue }) {
  if (existingIssue) {
    // Verify it exists
    try {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: existingIssue });
      return { number: data.number, node_id: data.node_id, html_url: data.html_url, created: false };
    } catch { /* fall through to create */ }
  }

  // Try exact-title match to reuse
  const q = `repo:${owner}/${repo} is:issue "${fmTitle.replace(/"/g,'\\"')}" in:title`;
  const search = await octokit.rest.search.issuesAndPullRequests({ q });
  const hit = search.data.items.find(i => i.title === fmTitle && !i.pull_request);
  if (hit) return { number: hit.number, node_id: hit.node_id, html_url: hit.html_url, created: false };

  // Create
  const created = await octokit.rest.issues.create({ owner, repo, title: fmTitle, body });
  // Write back issue number into the md file immediately
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  parsed.data.issue = created.data.number;
  fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
  return { number: created.data.number, node_id: created.data.node_id, html_url: created.data.html_url, created: true };
}

async function upsertComment({ owner, repo, issue_number, header, body }) {
  if (!mdToBool(body)) return;
  const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number, per_page: 100 });
  const marker = `**${header}**`;
  const existing = comments.find(c => (c.body || "").startsWith(marker));
  const newBody = `${marker}\n\n${body.trim()}`;
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: newBody });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number, body: newBody });
  }
}

function extractIssueNumber(ref, owner, repo) {
  if (!ref) return null;
  const s = String(ref).trim();
  if (/^#\d+$/.test(s)) return Number(s.slice(1));
  const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (m && (m[1].toLowerCase() === owner.toLowerCase()) && (m[2].toLowerCase() === repo.toLowerCase()))
    return Number(m[3]);
  return null;
}

// ---------- MAIN ----------

(async () => {
  const { owner, repo } = repoContext();
  const tasksDir = path.join(process.cwd(), TASKS_DIR);
  if (!fs.existsSync(tasksDir)) { console.log("No tasks dir"); return; }

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".md"));
  if (!files.length) { console.log("No md files"); return; }

  const project = await getProjectNode();
  const { map: fieldMap } = await getProjectFields(project.id);
  const statusField = fieldMap.get(STATUS_FIELD_NAME);

  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const { data, content } = matter(raw);

    const title = (data.title || path.basename(file, ".md")).trim();
    const body = (data.description || content || "").trim();

    // Ensure issue exists (reusing data.issue if present)
    const issue = await findOrCreateIssue({
      owner, repo, filePath, fmTitle: title, body, existingIssue: data.issue
    });
    console.log(`${issue.created ? "Created" : "Using"} issue #${issue.number} — ${issue.html_url}`);

    // Add to project
    const itemId = await addIssueToProject(project.id, issue.node_id);

    // Issue-side sync
    const assignees = Array.isArray(data.assignees) ? data.assignees : [];
    const labels = Array.isArray(data.labels) ? data.labels : [];
    const milestoneTitle = (data.milestone || "").trim();
    await setIssueBasics({ owner, repo, issueNumber: issue.number, assignees, labels, milestoneTitle });

    // Relationships: record as a comment list with references (GitHub auto-links)
    if (Array.isArray(data.relationships) && data.relationships.length) {
      await upsertComment({
        owner, repo, issue_number: issue.number,
        header: RELATIONSHIP_HEADER,
        body: data.relationships.map(String).join("\n")
      });
    }

    // Comments (freeform notes)
    if (mdToBool(data.comments)) {
      await upsertComment({
        owner, repo, issue_number: issue.number,
        header: COMMENT_HEADER,
        body: String(data.comments)
      });
    }

    // Project fields
    const desired = {
      [STATUS_FIELD_NAME]: data.status,
      "Priority": data.priority,        // SINGLE_SELECT
      "Size": data.size,                // SINGLE_SELECT
      "Estimate": data.estimate,        // NUMBER
      "Dev Hours": data.devHours,       // NUMBER
      "QA Hours": data.qaHours,         // NUMBER
      "Planned Start": data.plannedStart, // DATE (YYYY-MM-DD)
      "Planned End": data.plannedEnd,
      "Actual Start": data.actualStart,
      "Actual End": data.actualEnd
    };

    for (const [name, val] of Object.entries(desired)) {
      const field = fieldMap.get(name);
      if (field && mdToBool(val)) {
        await setFieldValue({ projectId: project.id, itemId, field, value: val });
        console.log(`Set field ${name} = ${val}`);
      }
    }
  }

  // Commit any frontmatter updates (e.g., issue number written back)
  if (fs.existsSync(".git")) {
    const { execSync } = require("child_process");
    try {
      if (execSync("git status --porcelain").toString().trim()) {
        execSync('git config user.name "github-actions[bot]"');
        execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
        execSync("git add -A");
        execSync('git commit -m "Write back issue numbers to Markdown"');
        execSync("git push");
      }
    } catch (e) { console.warn("Commit skipped:", e.message); }
  }
})().catch(err => core.setFailed(err.message));
