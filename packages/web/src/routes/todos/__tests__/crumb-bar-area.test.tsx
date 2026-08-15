import { render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { AREAS } from "@/contrib/types"
import { contributeProbes, describeHostedArea } from "@/contrib/__tests__/hosted-area"
import { CrumbBar } from "../task-page/crumb-bar"

/* PLA-107 — the crumb bar hosts `todo.detail.actions`. The contributed actions
 * lead the bar's right-hand group, so the app's own copy-link and ⋯ keep the
 * edge position the muscle memory expects. */

function renderCrumbBar() {
  render(
    <CrumbBar
      boardLabel="Platform"
      onBack={() => {}}
      ancestors={[]}
      id="PLA-12"
      title="A Todo"
      onOpenAncestor={() => {}}
      onCopyId={() => {}}
      mobile={false}
    />,
  )
}

describeHostedArea("the crumb bar", {
  area: AREAS.todoDetailActions,
  variant: "chip",
  renderHost: async () => renderCrumbBar(),
  findHostContent: async () => screen.getByTestId("task-copy-link"),
})

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
})

it("puts a contributed action inside the action group, ahead of copy-link", () => {
  dispose = contributeProbes(AREAS.todoDetailActions, [{ id: "widget" }])

  renderCrumbBar()

  const contributed = screen.getByTestId("probe-widget")
  const copyLink = screen.getByTestId("task-copy-link")

  expect(contributed.parentElement).toBe(copyLink.parentElement)
  expect(contributed.compareDocumentPosition(copyLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
