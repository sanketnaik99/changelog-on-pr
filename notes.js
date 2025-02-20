const core = require('@actions/core');
const github = require('@actions/github');

const octokit = new github.getOctokit(core.getInput('token'))
const owner = github.context.payload.repository.owner.login
const repo = github.context.payload.repository.name

function getPullNumber() {
  var manualNumber = core.getInput('pull_number')
  if (manualNumber) {
    return manualNumber
  } else {
    return github.event.pull_request.number
  }
}

function getHeadingLabels() {
  return core.getInput('labels').split(',')
}

function getHeadingTitles() {
  return core.getInput('titles').split(',')
}

function extractName(text) {
  const match = /^Co-authored-by: (.*) <.*$/.exec(text);
  if (match) {
    return match[1];
  }
  return undefined;
}

async function labelsOnPr(pull_number) {
  try {
    let pr = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number
    })
    return pr.data.labels.map(label => label.name.toLowerCase() )
  } catch (error) {
    console.log("Couldn't fetch PR " + pull_number)
    console.log(error)
    return []
  }
}

// Returns a map containing lists of change messages keyed by label/heading
async function changesByLabel(commitMessages) {
  var messagesByLabel = new Map() // label:[message1, message2, ...]
  let headingLabels = core.getInput('labels').split(',')
  let headingTitles = core.getInput('titles').split(',')
  let commitMessageFilters = core.getInput('filters').split(',').filter(Boolean)
  if (headingLabels.length !== headingTitles.length) {
    throw new Error('The number of labels and titles do not match')
  }
  for (const commitMsg of commitMessages) {
    let filteredCommitMessage = commitMsg
    var added = false
    if (commitMessageFilters.length > 0) {
      for (const filter of commitMessageFilters){
        const normalizedCommitMsg = commitMsg.replace(/\u00A0/g, ' ');
        const normalizedFilter = filter.replace(/\u00A0/g, ' ');
        if (normalizedCommitMsg.startsWith(normalizedFilter)){
          filteredCommitMessage = normalizedCommitMsg.replace(normalizedFilter, '')
        }
      }
    }

    // If there's a reference to a pull request
    if (commitMsg.match(/#\d+/)) {
      let prLabels = await labelsOnPr(commitMsg.match(/#(\d+)/)[1])
      prLabels.forEach(prLabel => {
        if (headingLabels.includes(prLabel)) {
          let titleIndex = headingLabels.findIndex(item => item === prLabel)
          let title = titleIndex === -1? "improvements": headingTitles[titleIndex]
          appendMessageByLabel(messagesByLabel, title, filteredCommitMessage)
          added = true
        }
      })
    }

    // unlabeled changes should be called 'improvements'
    if (!added) {
      appendMessageByLabel(messagesByLabel, "improvements", filteredCommitMessage)
    }
  } // for (... of commitMessages)

  return messagesByLabel
}

function appendMessageByLabel(messagesByLabel, label, message) {
  if (!messagesByLabel.has(label)) {
    messagesByLabel.set(label, "* " + message)
  } else {
    let messages = messagesByLabel.get(label)
    messagesByLabel.set(label, messages + "\n* " + message)
  }
}

function capitalize(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function fetchCoAuthors(commits) {
  let linesByEmail = new Map()

  // Gather co-authors that might have been squashed in earlier merges
  for (const msg of commits.map(el => el.message)) {
    msg.split("\n")
      .filter(line => line.match(/Co-authored-by:/) )
      .forEach(line => {
        // Name Name Name <example@users.noreply.github.com>
        let emails = line.match(/Co-authored-by:.*<(.*)>/)
        if (emails[1]) {
          linesByEmail.set(emails[1], extractName(emails[0]))
        } else {
          linesByEmail.set(line, extractName(line))
        }
      })
  }

  // Gather all the authors & committers of commits in this PR
  let coAuthorLine = author => `${author.name}` 
  commits.map(el => el.author).forEach(it => linesByEmail.set(it.email, coAuthorLine(it)))
  commits.map(el => el.committer).forEach(it => linesByEmail.set(it.email, coAuthorLine(it)))
  const authors = Array.from(linesByEmail.values()).filter(item => item !== 'GitHub')
  return authors.filter((author, index) => authors.indexOf(author) === index).join(", ")
}

async function createChangeList(commitMessages) {
  let firstLines = commitMessages.map(msg => { return msg.split("\n")[0] })
  let changes = await changesByLabel(firstLines)
  var body = ""

  // Add each category based on the inputs
  for (const key of getHeadingTitles()) {
    let value = changes.get(key)
    body += formattedCategory(key, value)
  }
  // If Improvements wasn't an input (affects heading order) then add it at the end for unlabeled changes
  if (!getHeadingTitles().includes("improvements")) {
    body += formattedCategory("improvements", changes.get("improvements"))
  }

  return body
}

function formattedCategory(key, value) {
  if (!value || value.length <= 0) {
    return ""
  }

  let body = ""
  body += "## "
  body += capitalize(key)
  body += "\n\n"
  body += value
  body += "\n\n"
  return body
}


async function main() {
  let pullNumber = getPullNumber()
  console.log(">release-notes-on-pr: Working on PR number " + pullNumber)

  // Create formatted changelog string from commits
  let commits = await octokit.paginate(
    octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pullNumber
  })
  let commitMessages = commits.map(el => el.commit.message )

  let changeList = await createChangeList(commitMessages)
  let coAuthorsList = fetchCoAuthors(commits.map(el => el.commit))
  let changelog = changeList + "\n\n" + "## Contributors\n" + coAuthorsList

  console.log("Adding Changelog:\n" + changelog)

  // Append the changelog to what's already in there
  let pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  })
  var body
  if (pr.data.body) {
    body = pr.data.body + "\n\n" + changelog
  } else {
    body = changelog
  }

  // Update the PR
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: pullNumber,
    body
  })
}

main()
  .catch(err => {
    console.log("Failed with error")
    console.log(err)
    core.setFailed(err.message)
  })
  .then(() => { console.log("Done! ") })
