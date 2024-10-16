/**
 * Sync new troubleshooting entries from the GitHub repo with GitHub
 * Discussions.
 */

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/core'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import matter from 'gray-matter'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { mdxFromMarkdown, mdxToMarkdown } from 'mdast-util-mdx'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfm } from 'micromark-extension-gfm'
import { mdxjs } from 'micromark-extension-mdxjs'
import crypto from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { stringify } from 'smol-toml'
import toml from 'toml'

import { type Database } from 'common'

import {
  getAllTroubleshootingEntries,
  getArticleSlug,
  type ITroubleshootingEntry,
} from './Troubleshooting.utils.ts'

let octokitInstance: Octokit
let supabaseAdminClient: SupabaseClient<Database>

function octokit() {
  if (!octokitInstance) {
    const privateKeyPkcs8 = crypto
      .createPrivateKey(process.env.DOCS_GITHUB_APP_PRIVATE_KEY!)
      .export({
        type: 'pkcs8',
        format: 'pem',
      })

    octokitInstance = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.DOCS_GITHUB_APP_ID,
        installationId: process.env.DOCS_GITHUB_APP_INSTALLATION_ID,
        privateKey: privateKeyPkcs8,
      },
    })
  }

  return octokitInstance
}

export function supabaseAdmin() {
  if (!supabaseAdminClient) {
    supabaseAdminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!
    )
  }

  return supabaseAdminClient
}

async function syncTroubleshootingEntries() {
  const troubleshootingEntries = await getAllTroubleshootingEntries()
  const discussions = await getAllTroubleshootingDiscussions()

  const tasks = troubleshootingEntries.map(async (entry) => {
    const databaseId = entry.data.database_id
    if (databaseId.startsWith('pseudo-')) {
      // The database entry is faked, so we may need to create a new entry.
      // There's also an edge case we need to check for: the entry has already
      // been created, but the new database ID hasn't been written to the file
      // yet.
      if (await entryExists(entry)) return

      const discussion = entry.data.github_url
        ? await getGithubIdForDiscussion(discussions, entry)
        : await createGithubDiscussion(entry)
      const id = await insertNewTroubleshootingEntry(entry, discussion)
      await updateFileId(entry, id)
    } else {
      // The database entry already exists, so check for updates.
      const contentHasChanged = await updateChecksumIfNeeded(entry)
      if (contentHasChanged) {
        await updateGithubDiscussion(entry)
      }
    }
  })

  const results = await Promise.allSettled(tasks)
  let hasErrors = false
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `Failed to insert and/or update GitHub discussion for ${troubleshootingEntries[index].filePath}:\n\n\t%O`,
        result.reason
      )
      hasErrors = true
    }
  })

  return hasErrors
}

async function entryExists(entry: ITroubleshootingEntry): Promise<boolean> {
  const checksum = calculateChecksum(entry.content)
  const { data, error } = await supabaseAdmin()
    .from('troubleshooting_entries')
    .select('id')
    .eq('checksum', checksum)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      // No entry found
      return false
    }
    throw error
  }

  console.log(
    `Entry for ${entry.data.title} already exists. Not creating a new one to prevent duplicates.`
  )
  return true
}

function calculateChecksum(content: string) {
  // Normalize to ignore changes that don't affect the final displayed content.
  const mdast = fromMarkdown(content, {
    extensions: [gfm(), mdxjs()],
    mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()],
  })
  const normalized = toMarkdown(mdast, { extensions: [gfmToMarkdown(), mdxToMarkdown()] })

  return createHash('sha256').update(normalized).digest('base64')
}

async function insertNewTroubleshootingEntry(
  entry: ITroubleshootingEntry,
  { id, url }: { id: string; url: string }
) {
  const timestamp = Date.now()
  const checksum = calculateChecksum(entry.content)

  const { data, error } = await supabaseAdmin()
    .from('troubleshooting_entries')
    .insert({
      api: entry.data.api,
      checksum,
      date_created: entry.data.date_created?.toString() ?? timestamp.toString(),
      date_updated: timestamp.toString(),
      errors: entry.data.errors,
      github_id: id,
      github_url: url,
      keywords: entry.data.keywords,
      title: entry.data.title,
      topics: entry.data.topics,
    })
    .select('id')
    .single()
  if (error) {
    throw error
  }

  return data.id
}

async function updateChecksumIfNeeded(entry: ITroubleshootingEntry) {
  const { data, error } = await supabaseAdmin()
    .from('troubleshooting_entries')
    .select('checksum')
    .eq('id', entry.data.database_id)
    .single()
  if (error) {
    throw error
  }

  if (data.checksum !== calculateChecksum(entry.content)) {
    const timestamp = new Date().toISOString()
    const { error } = await supabaseAdmin()
      .from('troubleshooting_entries')
      .update({
        checksum: calculateChecksum(entry.content),
        date_updated: timestamp,
      })
      .eq('id', entry.data.database_id)

    if (error) {
      throw error
    }

    return true
  }

  return false
}

function addCanonicalUrl(entry: ITroubleshootingEntry) {
  const docsUrl = 'https://supabase.com/docs/guides/troubleshooting/' + getArticleSlug(entry.data)
  const content =
    entry.content +
    `\n\n_This is a copy of a troubleshooting article on Supabase's docs site. You can find the original [here](${docsUrl})._`
}

async function createGithubDiscussion(entry: ITroubleshootingEntry) {
  const content = addCanonicalUrl(entry)

  const mutation = `
    mutation {
      createDiscussion(input: {
        repositoryId: "MDEwOlJlcG9zaXRvcnkyMTQ1ODcxOTM=",
        categoryId: "DIC_kwDODMpXOc4CUvEr",
        body: "${content}",
        title: "${entry.data.title}"
      }) {
        discussion {
          id
          url
        }
      }
    }
    `

  const { discussion } = await octokit().graphql<{ discussion: { id: string; url: string } }>(
    mutation
  )
  return discussion
}

async function getAllTroubleshootingDiscussions() {
  const troubleshootingCategoryId = 'DIC_kwDODMpXOc4CUvEr'
  const query = `
    query getDiscussions($cursor: String) {
      repository(owner: "supabase", name: "supabase") {
        discussions(first: 100, after: $cursor, categoryId: "${troubleshootingCategoryId}") {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            url
          }
        }
      }
    }
  `

  const discussions: { id: string; url: string }[] = []
  let hasNextPage = true
  let cursor: string

  while (hasNextPage) {
    const {
      repository: {
        discussions: { nodes: moreDiscussions, pageInfo },
      },
    } = await octokit().graphql<{
      repository: {
        discussions: {
          nodes: { id: string; url: string }[]
          pageInfo: { endCursor: string; hasNextPage: boolean }
        }
      }
    }>(query)

    discussions.push(...moreDiscussions)
    hasNextPage = pageInfo.hasNextPage
    cursor = pageInfo.endCursor
  }

  return discussions
}

async function getGithubIdForDiscussion(
  discussions: { id: string; url: string }[],
  entry: ITroubleshootingEntry
) {
  const matchingDiscussion = discussions.find(
    (discussion) => discussion.url === entry.data.github_url
  )
  if (!matchingDiscussion) {
    throw new Error(`No matching discussion found for URL: ${entry.data.github_url}`)
  }
  return matchingDiscussion
}

async function updateGithubDiscussion(entry: ITroubleshootingEntry) {
  const { data, error } = await supabaseAdmin()
    .from('troubleshooting_entries')
    .select('github_id')
    .eq('id', entry.data.database_id)
    .single()
  if (error) {
    throw error
  }

  const content = addCanonicalUrl(entry)
  const mutation = `
    mutation {
      updateDiscussion(input: {
        discussionId: "${data.github_id}",
        body: "${content}",
      }) {
      }
    }
    `

  await octokit().graphql(mutation)
}

async function updateFileId(entry: ITroubleshootingEntry, id: string) {
  const fileContents = await readFile(entry.filePath, 'utf-8')
  const { data, content } = matter(fileContents, {
    language: 'toml',
    engine: toml.parse.bind(toml),
  })
  data.database_id = id

  const newFrontmatter = stringify(data)
  const newContent = `---\n${newFrontmatter}\n---\n\n${content}`

  await writeFile(entry.filePath, newContent)
}

async function main() {
  try {
    const hasErrors = await syncTroubleshootingEntries()
    if (hasErrors) {
      process.exit(1)
    }
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

main()
