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
const TASKS_ARCHIVE_DIR = process.env.TASKS_ARCHIVE_DIR || path.join(TASKS_DIR, "archive");

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

// ---------- helpers ----------
function repoContext() { return github.context.repo; }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,80) || "task"; }

async function getProjectNode() {
  const orgQ = `query($login:String!,$number:Int!){ organization(login:$login){ projectV2(number:$number){ id title }}}`;
  const userQ = `query($login:String!,$number:Int!){ user(login:$login){ projectV2(number:$number){ id title }}}`;
  const asOrg = await octokit.graphql(orgQ, { login: OWNER, number: PROJECT_NUMBER }).catch(()=>null);
  if (asOrg?.organization?.projectV2) return asOrg.organization.projectV2;
  const asUser = await octokit.graphql(userQ, { login: OWNER, number: PROJECT_NUMBER }).catch(()=>null);
  if (asUser?.user?.projectV2) return asUser.user.projectV2;
  throw new Error(`Project v2 #${PROJECT_NUMBER} not found for ${OWNER}`);
}

async function getProjectWithFields(projectId) {
  const q = `
    query($projectId:ID!){
      node(id:$projectId){
        ... on ProjectV2 {
          id
          title
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
  return res.node;
}

async function getAllProjectItems(projectId) {
  const items = [];
  let cursor = null;
  const q = `
    query($projectId:ID!, $after:String){
      node(id:$projectId){
        ... on ProjectV2 {
          items(first:100, after:$after){
            nodes{
              id
              isArchived
              content { ... on Issue { id number title body url } }
              fieldValues(first:100){
                nodes{
                  ... on ProjectV2ItemFieldSingleSelectValue { field{... on ProjectV2FieldCommon{id name dataType}} name }
                  ... on ProjectV2ItemFieldNumberValue { field{... on ProjectV2FieldCommon{id name dataType}} number }
                  ... on ProjectV2ItemFieldDateValue { field{... on ProjectV2FieldCommon{id name dataType}} date }
                  ... on ProjectV2ItemFieldTextValue { field{... on ProjectV2FieldCommon{id name dataType}} text }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
  while (true) {
    const res = await octokit.graphql(q, { projectId, after: cursor });
    const page = res.node.items;
    items.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return items;
}

function parseFieldValues(node) {
  const out = {};
  for (const fv of node.fieldValues.nodes) {
    const name = fv.field?.name;
    if (!name) continue;
    if ("name" in fv && fv.name != null) out[name] = fv.name;
    if ("number" in fv && fv.number != null) out[name] = fv.number;
    if ("date" in fv && fv.date != null) out[name] = fv.date;
    if ("text" in fv && fv.text != null) out[name] = fv.text;
  }
  return out;
}

// Issue comments helpers
async function listAllIssueComments(octokit, { owner, repo, issue_number }) {
  const all = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({ owner, repo, issue_number, per_page: 100, page });
    all.push(...data);
    if (data.length < 100) break;
    page += 1;
  }
  return all;
}
function isAutomationComment(body) {
  if (!body) return false;
  return body.startsWith("**Automated Notes**") || body.startsWith("**Relationships**");
}
function formatCommentsForYaml(comments) {
  const lines = comments.map(c => {
    const created = (c.created_at || "").slice(0,10);
    const author = c.user?.login ? `@${c.user.login}` : "@unknown";
    const text = String(c.body || "").replace(/\r?\n+/g, " ").trim();
    return `- [${created}] ${author}: ${text}`;
  });
  return lines.length ? lines.join("\n") : undefined;
}

// ---------- main ----------
(async () => {
  const { owner, repo } = repoContext();

  ensureDir(TASKS_DIR);
  ensureDir(TASKS_ARCHIVE_DIR);

  // Build local index: issue# -> { file, parsed, isArchivedPath }
  const localIndex = new Map();
  function indexDir(dir, archivedFlag) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".md"))) {
      const p = path.join(dir, f);
      const parsed = matter(fs.readFileSync(p, "utf8"));
      const issueNo = parsed.data.issue ? Number(parsed.data.issue) : null;
      if (issueNo) localIndex.set(issueNo, { file: p, parsed, archivedFlag });
    }
  }
  indexDir(TASKS_DIR, false);
  if (fs.existsSync(TASKS_ARCHIVE_DIR)) indexDir(TASKS_ARCHIVE_DIR, true);

  // Fetch project + all items
  const project = await getProjectNode();
  const projectInfo = await getProjectWithFields(project.id);
  const allItems = await getAllProjectItems(project.id);

  // Build sets of current & archived issue numbers in the project
  const present = new Set();
  const archived = new Set();

  // Loop items to write/update files
  for (const item of allItems) {
    const issue = item.content; // Issue-backed items only
    if (!issue) continue;

    const issueNum = issue.number;
    present.add(issueNum);
    if (item.isArchived) archived.add(issueNum);

    // Pull issue details
    const ig = await octokit.rest.issues.get({ owner, repo, issue_number: issueNum });
    const assignees = ig.data.assignees?.map(a => a.login) || [];
    const labels = ig.data.labels?.map(l => typeof l === "string" ? l : l.name).filter(Boolean) || [];
    const milestone = ig.data.milestone?.title || undefined;

    // Comments (UI)
    const allComments = await listAllIssueComments(octokit, { owner, repo, issue_number: issueNum });
    const userComments = allComments.filter(c => !isAutomationComment(c.body));
    const commentsYaml = formatCommentsForYaml(userComments);

    // Fields
    const fields = parseFieldValues(item);
    const fmUpdates = {};
    fmUpdates.title = issue.title;
    if (issue.body && !fmUpdates.description) fmUpdates.description = issue.body;
    fmUpdates.issue = issueNum;
    if (fields[STATUS_FIELD_NAME] != null) fmUpdates.status = fields[STATUS_FIELD_NAME];
    if (fields["Priority"] != null) fmUpdates.priority = fields["Priority"];
    if (fields["Size"] != null) fmUpdates.size = fields["Size"];
    if (fields["Estimate"] != null) fmUpdates.estimate = fields["Estimate"];
    if (fields["Dev Hours"] != null) fmUpdates.devHours = fields["Dev Hours"];
    if (fields["QA Hours"] != null) fmUpdates.qaHours = fields["QA Hours"];
    if (fields["Planned Start"] != null) fmUpdates.plannedStart = fields["Planned Start"];
    if (fields["Planned End"] != null) fmUpdates.plannedEnd = fields["Planned End"];
    if (fields["Actual Start"] != null) fmUpdates.actualStart = fields["Actual Start"];
    if (fields["Actual End"] != null) fmUpdates.actualEnd = fields["Actual End"];
    fmUpdates.assignees = assignees;
    fmUpdates.labels = labels;
    if (milestone) fmUpdates.milestone = milestone;
    if (commentsYaml) fmUpdates.comments = commentsYaml + "\n";

    // Decide target directory (active vs archive)
    const targetDir = item.isArchived ? TASKS_ARCHIVE_DIR : TASKS_DIR;

    // Choose/ensure a filename
    let local = localIndex.get(issueNum);
    if (!local) {
      const fname = `${issueNum}-${slugify(issue.title)}.md`;
      const fp = path.join(targetDir, fname);
      local = { file: fp, parsed: matter("---\n---\n"), archivedFlag: item.isArchived };
      localIndex.set(issueNum, local);
    }

    // If file exists but is in the wrong folder (archive <-> active), move it
    const inArchive = local.archivedFlag === true;
    if (item.isArchived && !inArchive) {
      const newPath = path.join(TASKS_ARCHIVE_DIR, path.basename(local.file));
      ensureDir(TASKS_ARCHIVE_DIR);
      fs.renameSync(local.file, newPath);
      local.file = newPath;
      local.archivedFlag = true;
    } else if (!item.isArchived && inArchive) {
      const newPath = path.join(TASKS_DIR, path.basename(local.file));
      ensureDir(TASKS_DIR);
      fs.renameSync(local.file, newPath);
      local.file = newPath;
      local.archivedFlag = false;
    }

    // Merge FM and write
    const fm = { ...(local.parsed.data || {}), ...fmUpdates };
    const content = local.parsed.content || "";
    fs.writeFileSync(local.file, matter.stringify(content, fm));
    // refresh parsed for future operations
    local.parsed = matter(fs.readFileSync(local.file, "utf8"));

    console.log(`Synced ${path.relative(process.cwd(), local.file)} (${item.isArchived ? "archived" : "active"})`);
  }

  // Handle deletions: any local file whose issue# is NOT present in the project gets removed
  for (const [issueNo, info] of localIndex.entries()) {
    if (!present.has(issueNo)) {
      fs.unlinkSync(info.file);
      console.log(`Deleted local file for removed project item: ${path.relative(process.cwd(), info.file)}`);
    }
  }
})().catch(err => core.setFailed(err.message));
