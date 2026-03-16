#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { buildNotes, getLatestRelease } from "./changelog.ts"

const output = [`version=${Script.version}`]

if (!Script.preview) {
  let body = ""
  try {
    const prev = await getLatestRelease(Script.version)
    const notes = await buildNotes(prev, "HEAD")
    body = notes.join("\n")
  } catch (e) {
    console.log("Failed to generate changelog, falling back to commit list:", e)
    body = await $`git log --oneline -50`.text().then((x) => x.trim())
  }
  if (!body) body = "No notable changes"

  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const file = `${dir}/opencode-release-notes.txt`
  await Bun.write(file, body)
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --notes-file ${file}`
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --repo ${process.env.GH_REPO}`
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
