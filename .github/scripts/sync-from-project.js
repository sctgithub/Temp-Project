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

if (!token) { core.setFailed("PROJECTS_TOKEN missing"); process.exit(1); }
if (!OWNER || !PROJECT_NUMBER) { core.setFailed("OWNER/PROJECT_NUMBER missing"); process.exit(1); }

const octokit = github.getOctokit(token);

function repoContext() { return github.context.repo; }

function ensureDir() { if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true }); }

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,80) || "task";
}

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
  return res.node; // { id, title, fields }
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

// Pagination for issue comments
async function listAllIssueComments(octokit, { owner, repo, issue_number }) {
  const all = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({
      owner, repo, issue_number, per_page: 100, page
    });
    all.push(...data);
    if (data.length < 100) break;
    page += 1;
  }
  return all;
}

function isAutomationComment(body) {
  // exclude our own upserted comments
  if (!body) return false;
  return body.startsWith("**Automated Notes**") || body.startsWith("**Relationships**");
}

// Convert comments to a clean YAML-friendly multiline string
function formatCommentsForYaml(comments) {
  // e.g. "- [2025-08-16] @alice: Fixed env vars"
  const lines = comments.map(c => {
    const created = (c.created_at || "").slice(0, 10);
    const author = c.user?.login ? `@${c.user.login}` : "@unknown";
    // collapse newlines to avoid YAML ugliness; keep it simple
    const text = String(c.body || "").replace(/\r?\n+/g, " ").trim();
    return `- [${created}] ${author}: ${text}`;
  });
  return lines.length ? lines.join("\n") : undefined;
}



function parseFieldValues(node) {
  const out = {};
  for (const fv of node.fieldValues.nodes) {
    const name = fv.field?.name;
    if (!name) continue;
    if ("name" in fv && fv.name != null) out[name] = fv.name; // single-select
    if ("number" in fv && fv.number != null) out[name] = fv.number;
    if ("date" in fv && fv.date != null) out[name] = fv.date;
    if ("text" in fv && fv.text != null) out[name] = fv.text;
  }
  return out;
}

(async () => {
  const { owner, repo } = repoContext();
  const project = await getProjectNode();
  const projectInfo = await getProjectWithFields(project.id);
  const allItems = await getAllProjectItems(project.id);


  ensureDir();

  // Build index of task files by issue number
  const index = new Map();
  for (const f of (fs.readdirSync(TASKS_DIR).filter(f => f.endsWith(".md")))) {
    const p = path.join(TASKS_DIR, f);
    const parsed = matter(fs.readFileSync(p, "utf8"));
    if (parsed.data.issue) index.set(Number(parsed.data.issue), { file: p, parsed });
  }

  for (const item of allItems) {
    const issue = item.content;
    if (!issue) continue;
    const fields = parseFieldValues(item);

    // Pull issue details
    const ig = await octokit.rest.issues.get({ owner, repo, issue_number: issue.number });
	// Pull all UI comments (exclude automation comments)
    const allComments = await listAllIssueComments(octokit, {
      owner, repo, issue_number: issue.number
    });
    const userComments = allComments.filter(c => !isAutomationComment(c.body));
    const commentsYaml = formatCommentsForYaml(userComments);

    const assignees = ig.data.assignees?.map(a => a.login) || [];
    const labels = ig.data.labels?.map(l => typeof l === "string" ? l : l.name).filter(Boolean) || [];
    const milestone = ig.data.milestone?.title || undefined;

    // Choose a file path
    let fileInfo = index.get(issue.number);
    if (!fileInfo) {
      const fname = `${issue.number}-${slugify(issue.title)}.md`;
      const fp = path.join(TASKS_DIR, fname);
      fileInfo = { file: fp, parsed: matter("---\n---\n") };
      index.set(issue.number, fileInfo);
    }

    // Merge back into frontmatter
    const fm = fileInfo.parsed.data || {};
    fm.title = issue.title;
    // description/body is freeform; we won’t overwrite if file has explicit description
    if (!fm.description && issue.body) fm.description = issue.body;
    fm.issue = issue.number;

    // Project-driven fields (if present)
    const map = (src, key, dstKey) => { if (src[key] != null) fm[dstKey || key] = src[key]; };
    map(fields, STATUS_FIELD_NAME, "status");
    map(fields, "Priority", "priority");
    map(fields, "Size", "size");
    map(fields, "Estimate", "estimate");
    map(fields, "Dev Hours", "devHours");
    map(fields, "QA Hours", "qaHours");
    map(fields, "Planned Start", "plannedStart");
    map(fields, "Planned End", "plannedEnd");
    map(fields, "Actual Start", "actualStart");
    map(fields, "Actual End", "actualEnd");

    // Issue-driven fields
    fm.assignees = assignees;
    fm.labels = labels;
	if (commentsYaml) {
     // Store as a block scalar so YAML looks nice
     // gray-matter will keep formatting if we give it a string with newlines and a trailing newline
    fm.comments = commentsYaml + "\n";
    }

    if (milestone) fm.milestone = milestone;

    // Write file
    const content = fileInfo.parsed.content || "";
    fs.writeFileSync(fileInfo.file, matter.stringify(content, fm));
    console.log(`Updated ${path.basename(fileInfo.file)} from Project/Issue`);
  }
})().catch(err => core.setFailed(err.message));
