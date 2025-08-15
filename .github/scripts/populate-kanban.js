const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const core = require("@actions/core");
const github = require("@actions/github");

const token = process.env.GITHUB_TOKEN;
const OWNER = process.env.OWNER;                // org or username
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_FIELD_NAME = process.env.STATUS_FIELD_NAME || "Status";
const TASKS_DIR = process.env.TASKS_DIR || "tasks";

if (!token) throw new Error("GITHUB_TOKEN is required");
if (!OWNER) throw new Error("OWNER is required");
if (!PROJECT_NUMBER) throw new Error("PROJECT_NUMBER is required");

const octokit = github.getOctokit(token);

// --- Helpers -------------------------------------------------------------

async function findOrCreateIssue({ owner, repo, title, body }) {
  // Try to find an existing issue with the same title in this repo
  const q = `repo:${owner}/${repo} is:issue "${title.replace(/"/g, '\\"')}" in:title`;
  const search = await octokit.rest.search.issuesAndPullRequests({ q });
  const existing = search.data.items.find(i => i.title === title && !i.pull_request);

  if (existing) {
    return {
      number: existing.number,
      node_id: existing.node_id,
      html_url: existing.html_url,
      created: false,
    };
  }

  const created = await octokit.rest.issues.create({ owner, repo, title, body });
  return {
    number: created.data.number,
    node_id: created.data.node_id,
    html_url: created.data.html_url,
    created: true,
  };
}

/**
 * Get ProjectV2 node for OWNER + PROJECT_NUMBER.
 * Tries org first; if not found, tries user.
 */
async function getProjectNode() {
  // Try as organization project
  const orgQuery = `
    query($login:String!, $number:Int!) {
      organization(login:$login) {
        projectV2(number:$number) {
          id
          title
        }
      }
    }
  `;
  const orgRes = await octokit.graphql(orgQuery, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);

  if (orgRes && orgRes.organization && orgRes.organization.projectV2) {
    return orgRes.organization.projectV2; // { id, title }
  }

  // Try as user project
  const userQuery = `
    query($login:String!, $number:Int!) {
      user(login:$login) {
        projectV2(number:$number) {
          id
          title
        }
      }
    }
  `;
  const userRes = await octokit.graphql(userQuery, { login: OWNER, number: PROJECT_NUMBER }).catch(() => null);

  if (userRes && userRes.user && userRes.user.projectV2) {
    return userRes.user.projectV2;
  }

  throw new Error(`Project v2 number ${PROJECT_NUMBER} not found for owner ${OWNER} (org or user).`);
}

/**
 * Retrieves the Status field ID and its single-select options.
 */
async function getStatusField(projectId) {
  const query = `
    query($projectId:ID!) {
      node(id:$projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;
  const res = await octokit.graphql(query, { projectId });
  const fields = res.node.fields.nodes;

  // Find the single-select field named STATUS_FIELD_NAME
  const statusField = fields.find(
    f => f.name === STATUS_FIELD_NAME && f.dataType === "SINGLE_SELECT"
  );

  if (!statusField) {
    const available = fields.map(f => `${f.name} [${f.dataType}]`).join(", ");
    throw new Error(
      `Could not find a single-select field named "${STATUS_FIELD_NAME}". Available fields: ${available}`
    );
  }

  return statusField; // has id, name, options[]
}

/**
 * Adds an issue to the project and returns the created item id.
 */
async function addIssueToProject({ projectId, issueNodeId }) {
  const mutation = `
    mutation($projectId:ID!, $contentId:ID!) {
      addProjectV2ItemById(input: {projectId:$projectId, contentId:$contentId}) {
        item {
          id
        }
      }
    }
  `;
  const res = await octokit.graphql(mutation, { projectId, contentId: issueNodeId });
  return res.addProjectV2ItemById.item.id;
}

/**
 * Sets a single-select field value (e.g., Status) on a project item.
 */
async function setSingleSelectField({ projectId, itemId, fieldId, optionId }) {
  const mutation = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item { id }
      }
    }
  `;
  await octokit.graphql(mutation, { projectId, itemId, fieldId, optionId });
}

/**
 * Resolve a repo owner/repo from the current workflow context.
 * If you want to target a different repo, hardcode owner/repo below.
 */
function getRepoContext() {
  const { owner, repo } = github.context.repo;
  return { owner, repo };
}

// --- Main ---------------------------------------------------------------

(async () => {
  const tasksDir = path.join(process.cwd(), TASKS_DIR);
  if (!fs.existsSync(tasksDir)) {
    console.log(`No ${TASKS_DIR} directory—nothing to do.`);
    return;
  }

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".md"));
  if (!files.length) {
    console.log("No .md files in tasks/ — nothing to do.");
    return;
  }

  const { owner, repo } = getRepoContext();
  console.log(`Using repo ${owner}/${repo}`);

  // Fetch project and status field metadata once
  const project = await getProjectNode();
  console.log(`Project found: ${project.title} (${project.id})`);
  const statusField = await getStatusField(project.id);
  const optionsByName = new Map(
    statusField.options.map(o => [o.name.toLowerCase(), o])
  );

  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const { data, content } = matter(raw);

    const title = (data.title || path.basename(file, ".md")).trim();
    const body = (data.description || content || "").trim();
    const statusName = (data.status || "").toLowerCase();

    if (!title) {
      console.log(`Skipping ${file} — missing title`);
      continue;
    }

    // Create or reuse issue
    const issue = await findOrCreateIssue({ owner, repo, title, body });
    console.log(
      `${issue.created ? "Created" : "Found"} issue #${issue.number}: ${issue.html_url}`
    );

    // Add the issue to the project
    const itemId = await addIssueToProject({
      projectId: project.id,
      issueNodeId: issue.node_id,
    });
    console.log(`Added issue #${issue.number} to project item: ${itemId}`);

    // Set the Status field (if provided and matches an option)
    if (statusName) {
      const opt = optionsByName.get(statusName);
      if (!opt) {
        const available = [...optionsByName.keys()].join(", ");
        console.warn(
          `Warning: status "${data.status}" not found in project options. Available: ${available}`
        );
      } else {
        await setSingleSelectField({
          projectId: project.id,
          itemId,
          fieldId: statusField.id,
          optionId: opt.id,
        });
        console.log(`Set Status to "${opt.name}" for item ${itemId}`);
      }
    } else {
      console.log(`No 'status' provided in ${file} — leaving as default`);
    }
  }
})().catch(err => {
  core.setFailed(err.message);
});
