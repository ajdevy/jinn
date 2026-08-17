# Talk control coverage

> Generated from `APP_ROUTES` and `TALK_SURFACE_COVERAGE`. Edit the typed inventory, not this table.

| Route | Path | Context | Evidence and controls |
| --- | --- | --- | --- |
| chat | `/` | semantic | selected session and transcript; controls: open, message, continue, stop |
| chat-redirect | `/chat` | semantic | redirect destination; controls: navigate |
| cron-list | `/cron` | semantic | jobs, filters, and run summaries; controls: filter, open, trigger |
| cron-detail | `/cron/:id` | semantic | selected job and run history; controls: edit, enable, disable, trigger |
| todos-index | `/todos` | semantic | board redirect; controls: navigate |
| todo-board | `/todos/b/:board` | semantic | board, filters, and visible Todos; controls: filter, open, create |
| todo-detail | `/todos/:todoId` | semantic | selected Todo, status, relations, comments, and runs; controls: edit, comment, assign, delegate, state |
| notes-list | `/notes` | semantic | note list and search; controls: open, create |
| notes | `/notes/*` | semantic | selected note and folder; controls: open, create, update |
| experiments-list | `/experiments` | semantic | experiment filters and summaries; controls: open, create |
| experiment-detail | `/experiments/:id` | semantic | selected hypothesis, metrics, readings, and verdict; controls: record, conclude, reopen |
| kanban-redirect | `/kanban` | semantic | redirect destination; controls: navigate |
| logs | `/logs` | semantic | bounded redacted activity summary; controls: refresh |
| limits | `/limits` | semantic | engine limit windows and freshness; controls: refresh |
| org | `/org` | semantic | employee, reporting line, and activity; controls: open, delegate |
| settings-plugins | `/settings/plugins` | semantic | plugin inventory and state; controls: enable, disable, rescan |
| settings | `/settings` | semantic | active settings and safe configuration summary; controls: update |
| skills-list | `/skills` | semantic | installed skill summaries; controls: open |
| skill-detail | `/skills/:name` | semantic | selected skill metadata and content; controls: update |
| file | `/file` | semantic | published file metadata and preview; controls: open, attach |
| more | `/more` | semantic | available destinations; controls: navigate |
| workflow-list | `/workflow` | semantic | workflow definitions and status; controls: open, start |
| workflow-detail | `/workflow/:id` | semantic | definition, revision, graph, and runs; controls: edit, start, enable, disable |
| workflow-run | `/workflow/:id/runs/:runId` | semantic | selected run, node, attempts, gates, and output; controls: cancel, input, decide |
| talk-orb | `/talk-orb` | semantic | development orb bench state; controls: none |
| redesign | `/redesign` | semantic | development-only design bench; controls: none |
| plugin-contributed | `/*` | explicit gap | plugin-context-unavailable; plugin host SDK publishes route, selected object, controls, and freshness |

A normal question uses semantic context. One bounded image is permitted only when the current surface declares a named visual gap; the Talk orb, hidden content, secrets, and password inputs are excluded.
