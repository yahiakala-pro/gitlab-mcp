# Fork notes — GitLab CE compatibility patch

This fork of [`zereight/gitlab-mcp`](https://github.com/zereight/gitlab-mcp)
(`upstream`, read-only) exists to run against **GitLab CE 18.11** (self-managed),
where upstream's work-item tools break at the GraphQL layer. Branch
`patch-v2.2.6` carries the patch; `main` tracks upstream.

Why it broke (details in wayfinder map 77, tickets #96/#101): GitLab CE serves a
**license-filtered GraphQL schema at query-validation time** while introspection
still returns the full EE schema — so a query can *introspect fine* and still be
refused. The `workitems` toolset's queries name paid-tier widget types and
fields that CE rejects wholesale.

## Patched tools

- `get_work_item` / `list_work_items` — widget fragments trimmed to the
  CE-existing set (`Hierarchy`, `Labels`, `Assignees`, `StartAndDueDate`,
  `Milestone`, `LinkedItems`, `TimeTracking`, `Development`);
  `Status`/`Weight`/`HealthStatus`/`CustomFields`/`Iteration`/`Progress`/`Color`
  dropped (no such types at CE validation), `LinkedItems` without its
  EE-only `blocked`/`blockedByCount`/`blockingCount`, `Development` without
  `featureFlags`.
- `update_work_item` — return selection trimmed the same way; input pushes for
  `weightWidget`/`statusWidget`/`healthStatusWidget`/`iterationWidget`/
  `customFieldsWidget` dropped (CE rejects the input types at validation).
  The proven-on-CE inputs — `title`, `descriptionWidget.description`,
  `assigneesWidget.assigneeIds` (`[UserID!]!`), `labelsWidget.addLabelIds`/
  `removeLabelIds`, `stateEvent` (`CLOSE`/`REOPEN`), `hierarchyWidget.parentId`
  (null detaches), `hierarchyWidget.childrenIds`, `confidential`,
  `startAndDueDateWidget`, `milestoneWidget` — all unchanged.
- `list_work_item_emoji_reactions` — now reads the
  `WorkItemWidgetAwardEmoji.awardEmoji` widget (`Query.awardable` **never
  existed on any GitLab**, and the old path failed validation on every call).

## New tool

- `delete_work_item` — REST `DELETE /projects/:id/issues/:iid`, which GitLab
  treats uniformly across work-item types (verified on CE 18.11: task, issue).

## Trimmed (dead on this instance, unfixable by anyone)

- `list_work_item_statuses`, `list_custom_field_definitions` — paid-tier
  (Premium) features, invisible on CE.
- `list/create/delete_work_item_note_emoji_reaction` — GitLab refuses award
  emoji on note awardable IDs at the application layer.

## Live-path tests

`test/live-work-items.mjs` (`npm run test:live:workitems`) drives the real
server over stdio against a real GitLab: tools/list shape, create → update
sink → get readback → list search/state → emoji add/list/delete → delete →
404 path, with a self-cleaning throwaway. Upstream had **zero live coverage**
of these paths — that is how the CE drift landed silently. Run it with
`GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_API_URL`, `TEST_PROJECT_ID`.

## Publishing the image

A `v<base>-ce.<n>` tag pushed to `github` is a release:
[docker-publish-ce.yml](.github/workflows/docker-publish-ce.yml) builds each
platform natively (amd64 on `ubuntu-latest`, arm64 on GitHub's free arm64
runner — the fork is public) and pushes the merged manifest to
`ghcr.io/yahiakala-pro/gitlab-mcp:<tag>` with the workflow's `GITHUB_TOKEN` —
no PAT, no Docker Hub, no QEMU (the alpine `npm ci` hang the Dockerfile
header documents only bites under emulation):

```bash
git push github patch-v2.2.6          # or its rebased successor
git tag v<base>-ce.<n>
git push github v<base>-ce.<n>
```

- Tag events run from the **tagged commit's tree** — the workflow file must
  be on the tagged branch (it rides the patch branch; a rebase carries it).
- **First release only**: GHCR packages start private. Flip it to public once
  at https://github.com/users/yahiakala-pro/packages/container/gitlab-mcp/settings
- Verify without logging in:
  `docker buildx imagetools inspect ghcr.io/yahiakala-pro/gitlab-mcp:v<base>-ce.<n>`
- After publishing, pin the new digest into `mcp-gateway/profile.yaml` (both
  `image:` fields) and redeploy per its README — retiring the
  `gitlab.prolucid.ca:9090` reference in the process.

## Revisit trigger

When a `zereight` release queries `workItemFeatures`/widgets in a way that
validates on CE (or CE grows these widgets), this `live-work-items` suite
against upstream should pass — then this fork can be dropped for a pinned
upstream tag. Until then, rebase `patch-v2.2.6` onto new upstream tags as
needed (`git fetch upstream && git rebase`).