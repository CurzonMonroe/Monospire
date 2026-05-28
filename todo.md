# Monospire v2 Mindmap View Requirements

## Implementation Status

- [x] v2 implementation pass completed in `mindmap-core.js`, `renderer.js`, `index.html`, `styles.css`, `main.js`, and `preload.js`.
- [x] Parser and layout logic covered by `npm test`.
- [x] JavaScript syntax checks passed for renderer, main, preload, and mindmap core.
- [x] Electron startup smoke test completed with no terminal startup errors.
- [x] No current blockers are listed in `blocked.md`.
- [x] Source version updated to `2.0.0`.

## Remaining Release Readiness

- [ ] Run a full packaged build for `2.0.0` with `npm run dist:mac`.
- [ ] Regenerate and verify the Homebrew cask files after the `2.0.0` DMG exists so the URL and SHA256 match the actual artifact.
- [ ] Do a final manual UI pass over Mindmap, Settings, About, Tools menu, light mode, dark mode, export, and app relaunch before tagging.
- [ ] Consider whether PNG mindmap export is required for v2; current implemented export formats are SVG and PDF.

## Product Goal

- [ ] Add a readonly Mindmap view that renders ordinary Markdown list structures as a traditional mindmap diagram while keeping Markdown as the single source of truth.
- [ ] Make the first version genuinely usable for planning and thinking work, not just a proof of concept.
- [ ] Preserve Monospire's existing Markdown editor, formatted preview, split view, themes, export behaviour, outline, and Mermaid support unless a requirement explicitly changes them.
- [ ] Build the feature with clear internal foundations for later interactive editing, branch collapsing, drag rearrangement, and richer node metadata.

## Scope Boundaries

- [ ] Implement Mindmap view as readonly in v2; all content edits continue to happen through the raw Markdown editor or existing formatted editing flows.
- [ ] Do not introduce a proprietary mindmap file format in v2.
- [ ] Store mindmap content in normal `.md`, `.markdown`, or `.txt` documents.
- [ ] Allow the feature to work without requiring users to write Mermaid syntax.
- [ ] Do not remove or downgrade existing Mermaid fenced-code rendering.
- [ ] Do not require an internet connection for mindmap rendering.
- [ ] Do not add external hosted services or telemetry.

## Markdown Source Model

- [ ] Treat nested Markdown lists as the primary mindmap input.
- [ ] Support unordered list markers `-`, `*`, and `+`.
- [ ] Support ordered list markers such as `1.`, `2.`, and `1)`.
- [ ] Support mixed ordered and unordered lists in the same mindmap.
- [ ] Support indentation with spaces and tabs, normalising tabs consistently with the Markdown parser used by the app.
- [ ] Support multiple root-level list items by rendering them under a generated document root.
- [ ] If the document starts with a heading followed by a list, use the first heading as the mindmap root label.
- [ ] If no heading exists but the document has exactly one top-level list item, use that item as the visible root.
- [ ] If no heading exists and multiple top-level list items exist, use the current file name as the generated root label when available.
- [ ] If no file name is available, use `Mindmap` as the generated root label.
- [ ] Ignore YAML/front matter when parsing mindmap content.
- [ ] Ignore fenced code blocks when parsing list content.
- [ ] Ignore indented code blocks when parsing list content.
- [ ] Preserve inline Markdown formatting inside node labels where practical, including bold, italic, inline code, links, and highlights.
- [ ] Render unsupported inline formatting as readable plain text rather than failing the whole diagram.
- [ ] Support Markdown task list items by showing checked and unchecked states visually on the corresponding node.
- [ ] Support list item continuation paragraphs by appending the continuation text to the same node summary.
- [ ] Support hard and soft line breaks in list item content without corrupting hierarchy.
- [ ] Support special characters in node text, including quotes, brackets, punctuation, ampersands, emoji already present in the document, and non-Latin characters.
- [ ] Detect and report empty mindmap input when the document contains no parseable heading or list structure.

## Mindmap Metadata Syntax

- [ ] Support optional node metadata in Markdown comments immediately after a list item.
- [ ] Define metadata comments using the form `<!-- mindmap: key=value key=value -->`.
- [ ] Support `color` metadata for node accent colour.
- [ ] Support `fill` metadata for node background colour.
- [ ] Support `icon` metadata for a built-in symbolic icon name.
- [ ] Support `image` metadata for a local image path or Markdown-relative asset path.
- [ ] Support `shape` metadata for at least `rounded`, `rectangle`, `pill`, and `circle`.
- [ ] Support `collapsed` metadata for future compatibility, but ignore actual collapse behaviour in v2 unless a lightweight readonly collapse can be added safely.
- [ ] Validate metadata keys and values without throwing uncaught errors.
- [ ] Ignore unknown metadata keys while preserving them in the source document.
- [ ] Document metadata syntax in code comments and tests so later editing features can reuse it.
- [ ] Ensure metadata syntax remains optional; ordinary Markdown lists must render cleanly without any annotations.

## Colour Support

- [ ] Provide automatic branch colouring when no explicit node colour is set.
- [ ] Use a balanced default palette that works in light and dark themes.
- [ ] Assign consistent branch colours from stable node positions so colours do not change unexpectedly while typing unrelated content.
- [ ] Allow explicit node accent colour via metadata.
- [ ] Allow explicit node fill colour via metadata.
- [ ] Accept hex colours such as `#2563eb`.
- [ ] Accept a constrained list of named colours such as `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `gray`, and `slate`.
- [ ] Reject or ignore unsafe CSS values such as `url(...)`, `expression(...)`, malformed functions, and arbitrary raw CSS.
- [ ] Ensure node text contrast remains readable when a custom fill colour is provided.
- [ ] Ensure connector lines inherit branch colour unless overridden by node style.
- [ ] Ensure selected, hovered, focused, and highlighted nodes remain visually distinct in both light and dark themes.

## Graphics Support

- [ ] Support built-in icons on nodes using local assets or safe inline SVG/icon primitives.
- [ ] Prefer existing app icon conventions and bundled assets where possible.
- [ ] Support local image thumbnails on nodes via `image` metadata.
- [ ] Resolve relative image paths relative to the current document path when the document has been saved.
- [ ] Resolve relative image paths relative to the project/app working directory only when no document path is available.
- [ ] Reject remote image URLs in v2 unless an explicit later requirement enables them.
- [ ] Reject unsupported protocols such as `javascript:`, `data:` from user-authored metadata unless a safe allowlist is deliberately implemented.
- [ ] Constrain image thumbnails to stable dimensions so they do not cause layout jumps.
- [ ] Show a graceful missing-image placeholder if the asset cannot be loaded.
- [ ] Support alt text or accessible labels for icon/image nodes where available.
- [ ] Ensure images render inside exported SVG/PNG/PDF only if the export format can safely embed or reference them.
- [ ] If export embedding is not implemented in v2, clearly render a placeholder in exported output rather than failing export.

## Parser Architecture

- [ ] Create a dedicated mindmap parser module or clearly isolated parser section in `renderer.js`.
- [ ] Represent parsed mindmaps with a stable tree data structure containing id, label, rawText, depth, children, source line range, list marker type, task state, metadata, and diagnostics.
- [ ] Generate deterministic node ids from source positions and local sibling indexes.
- [ ] Keep parser output independent from the renderer so future editing can modify tree nodes before serialising Markdown.
- [ ] Return recoverable diagnostics for malformed metadata, empty diagrams, unsupported graphics, and invalid colours.
- [ ] Keep diagnostics non-blocking unless no usable mindmap can be rendered.
- [ ] Add unit-testable pure functions for parsing Markdown into a mindmap tree.
- [ ] Add unit-testable pure functions for converting a mindmap tree into render-ready layout data.
- [ ] Avoid ad hoc parsing where `markdown-it` tokens can provide more reliable structure.
- [ ] If Markdown list token parsing proves too restrictive, isolate fallback indentation parsing behind tests.

## Renderer Architecture

- [ ] Implement a renderer that can draw the mindmap in a dedicated Mindmap pane.
- [ ] Prefer a renderer that supports SVG output or an SVG-backed DOM so export and accessibility are practical.
- [ ] Keep rendering data-driven: renderer consumes the parsed tree and layout options, not raw Markdown.
- [ ] Use a layout algorithm suitable for traditional mindmaps with root near the centre or left and branches flowing outward.
- [ ] Support at least 4 hierarchy levels without overlapping nodes in typical documents.
- [ ] Support at least 100 nodes with acceptable interactive performance on a normal desktop Mac.
- [ ] Render connector curves between parent and child nodes.
- [ ] Render branch colours on connectors and node accents.
- [ ] Render task check state, icons, and image thumbnails in or beside nodes.
- [ ] Render long labels with wrapping and stable node dimensions.
- [ ] Provide a readable fallback layout for very deep or very wide maps.
- [ ] Avoid text overlap, connector-label overlap, and clipped node text.
- [ ] Re-render efficiently when Markdown changes, using debouncing or existing render scheduling where appropriate.
- [ ] Do not block typing in the Markdown editor while a mindmap render is pending.
- [ ] Cancel or supersede stale renders when the Markdown changes quickly.
- [ ] Ensure renderer errors show in the Mindmap pane without crashing the app.

## View Modes and UI

- [ ] Add a Mindmap pane to `index.html` alongside the raw and formatted panes.
- [ ] Add workspace CSS modes for raw-only, preview-only, mindmap-only, raw+preview, raw+mindmap, preview+mindmap, and any supported three-pane state.
- [ ] Keep the initial v2 default view unchanged unless the user explicitly enables Mindmap view.
- [ ] Add a View menu checkbox named `Show Mindmap`.
- [ ] Add an app menu action and renderer handler for toggling Mindmap view.
- [ ] Add a native menu state field for whether Mindmap view is visible.
- [ ] Add a command palette action for toggling Mindmap view.
- [ ] Add a ribbon control for Mindmap view if the existing ribbon has an appropriate View or Preview area.
- [ ] Ensure at least one content pane remains visible when users toggle views.
- [ ] Preserve existing Show Markdown Editor and Show Preview behaviour.
- [ ] Define deterministic behaviour when all three panes are enabled on small screens.
- [ ] Respect existing horizontal and vertical split orientation settings where applicable.
- [ ] Add a Mindmap pane header or compact toolbar with zoom controls, fit-to-view, reset view, and export actions.
- [ ] Use icon buttons with tooltips for mindmap toolbar controls where icons are available.
- [ ] Do not add explanatory marketing copy inside the work surface.
- [ ] Ensure keyboard focus can enter and leave the Mindmap pane predictably.
- [ ] Ensure the Mindmap pane is marked readonly for assistive technology.

## Mindmap Navigation

- [ ] Support mouse wheel or trackpad scrolling/panning in the Mindmap pane.
- [ ] Support pinch or modifier-wheel zoom if feasible in Electron.
- [ ] Support toolbar zoom in, zoom out, reset zoom, and fit-to-view.
- [ ] Persist current zoom/pan in the session state while the document window remains open.
- [ ] Reset zoom/pan sensibly when opening a different file.
- [ ] Support keyboard navigation between visible nodes using arrow keys or tab order.
- [ ] Highlight the focused node.
- [ ] Show node source location on hover or in an accessible label.
- [ ] Clicking a node should move the raw editor selection to the corresponding source line when the raw editor is visible.
- [ ] Clicking a node should not edit text in v2.

## Theme Integration

- [ ] Make Mindmap view honour light, dark, and auto theme modes.
- [ ] Make Mindmap view visually compatible with existing Monospire themes.
- [ ] Use existing CSS variables for chrome, text, background, borders, and muted text wherever practical.
- [ ] Add specific CSS variables for mindmap node fill, node border, connector opacity, focus ring, image placeholder, and diagnostic text.
- [ ] Ensure user preview CSS does not accidentally break the Mindmap pane.
- [ ] Ensure theme changes trigger a Mindmap re-render or restyle without requiring app restart.
- [ ] Ensure the Mindmap pane works in print/export-oriented themes even if visual richness is reduced.

## Persistence and Settings

- [ ] Persist whether Mindmap view is enabled using the existing settings pattern in `main.js` and `preload.js`.
- [ ] Persist Mindmap zoom preference only if product behaviour calls for cross-document persistence; otherwise keep zoom/pan per session.
- [ ] Persist branch colour mode if a UI setting is added.
- [ ] Include Mindmap view visibility in published session state.
- [ ] Restore Mindmap visibility after window reload if the user previously enabled it.
- [ ] Ensure settings migration handles users who do not yet have any mindmap settings.
- [ ] Ensure malformed settings values fall back safely.

## Export Requirements

- [ ] Add `Export Mindmap as SVG`.
- [ ] Add `Export Mindmap as PNG` if the SVG renderer can be rasterised reliably.
- [ ] Add `Export Mindmap as PDF` if Electron print-to-PDF or existing export utilities can render the Mindmap pane cleanly.
- [ ] Export the current rendered mindmap, including colours and built-in icons.
- [ ] Include image thumbnails in export only when safe local embedding is implemented.
- [ ] Use the current file name as the default export name with a `-mindmap` suffix.
- [ ] Show a clear error if export is requested before a mindmap can be rendered.
- [ ] Do not mutate the Markdown document during export.
- [ ] Keep existing Markdown, HTML, DOCX, and PDF export behaviours intact.

## Diagnostics and Empty States

- [ ] Show a calm empty state when no list or heading structure can be parsed.
- [ ] Show parser diagnostics in a compact non-modal area of the Mindmap pane.
- [ ] Include source line numbers in diagnostics when available.
- [ ] Do not show diagnostics for harmless ordinary Markdown that is irrelevant to the mindmap.
- [ ] Show a warning when remote images are ignored.
- [ ] Show a warning when metadata colour values are invalid.
- [ ] Show a warning when a local image cannot be found.
- [ ] Log render failures through the existing diagnostic logging pattern if appropriate.

## Accessibility

- [ ] Provide an accessible tree representation of the mindmap for screen readers.
- [ ] Give each node an accessible name derived from its label and task state.
- [ ] Ensure icons and graphics do not replace the text label as the only meaning.
- [ ] Ensure focus rings meet contrast requirements in light and dark modes.
- [ ] Ensure toolbar buttons have labels or titles.
- [ ] Ensure readonly state is communicated to assistive technology.
- [ ] Avoid colour-only meaning; task state, icons, and labels must remain understandable without colour.

## Security

- [ ] Sanitize all rendered node labels before injecting them into DOM or SVG.
- [ ] Sanitize metadata values before using them in attributes, styles, file paths, or URLs.
- [ ] Use DOM APIs for SVG/HTML construction where practical instead of string concatenation.
- [ ] For any deliberate HTML label rendering, route content through the existing Markdown sanitisation assumptions and add tests.
- [ ] Block script execution from node labels, metadata, images, and SVG exports.
- [ ] Ensure local image path handling cannot read arbitrary sensitive files through exported output without explicit user intent.
- [ ] Avoid enabling Node integration in any new iframe or rendering context.
- [ ] Keep Content Security Policy assumptions at least as strict as the existing app.

## Performance

- [ ] Debounce mindmap parsing and rendering during typing.
- [ ] Avoid reparsing unchanged Markdown when possible.
- [ ] Avoid re-rendering when only unrelated UI state changes.
- [ ] Render a 100-node map within a target of 250ms after debounce on a typical development machine.
- [ ] Keep typing latency acceptable while Mindmap view is visible.
- [ ] Add a graceful large-document path for maps over 250 nodes, such as simplified styling or a diagnostic notice.
- [ ] Prevent memory leaks by cleaning up old SVG/DOM nodes, timers, listeners, and object URLs.

## Testing Requirements

- [ ] Add parser tests for single-root lists.
- [ ] Add parser tests for multiple-root lists.
- [ ] Add parser tests for heading-derived roots.
- [ ] Add parser tests for mixed ordered and unordered lists.
- [ ] Add parser tests for task list nodes.
- [ ] Add parser tests for continuation paragraphs.
- [ ] Add parser tests for fenced code blocks being ignored.
- [ ] Add parser tests for front matter being ignored.
- [ ] Add parser tests for metadata comments.
- [ ] Add parser tests for invalid metadata.
- [ ] Add parser tests for colour allowlist and unsafe CSS rejection.
- [ ] Add renderer tests or DOM smoke checks for node labels, connectors, colours, icons, images, and diagnostics.
- [ ] Add regression tests to ensure existing Markdown preview rendering still works.
- [ ] Add regression tests to ensure existing Mermaid preview rendering still works.
- [ ] Add manual QA checklist entries for light mode, dark mode, split view, large maps, export, and missing images.
- [ ] If automated Electron UI tests are available, add a smoke test that opens a Markdown list, enables Mindmap view, and verifies a non-empty diagram.

## Implementation Touchpoints

- [ ] Update `index.html` with the Mindmap pane and toolbar markup.
- [ ] Update `styles.css` with workspace layout modes, Mindmap pane styling, node styling, toolbar styling, diagnostics styling, and responsive behaviour.
- [ ] Update `renderer.js` with parser functions, render scheduling, Mindmap pane lifecycle, toolbar actions, menu action handling, command palette entry, and session state.
- [ ] Update `main.js` with View menu item, settings persistence handlers, native menu state syncing, and export IPC handlers if export needs main-process support.
- [ ] Update `preload.js` with any new safe IPC bridge methods for settings, image resolution, or export.
- [ ] Update `README.md` with a concise feature note and local syntax examples after implementation.
- [ ] Add or update tests using the project's existing test approach; if no test runner exists, add the smallest suitable test harness for pure parser functions.
- [ ] Avoid broad refactors outside the files needed for Mindmap view.

## Future-Ready Foundations

- [ ] Keep parsed node source ranges accurate enough for later write-back editing.
- [ ] Preserve list marker type and indentation in parser output for future Markdown serialisation.
- [ ] Keep metadata attached to node objects without requiring renderer-specific fields.
- [ ] Design renderer events around semantic node actions such as `select`, `focus`, `requestEdit`, `toggleCollapse`, and `openLink`, even if only `select` and `focus` are used in v2.
- [ ] Keep collapse state represented separately from source metadata so future UI-only collapse is possible.
- [ ] Avoid baking readonly assumptions into parser or data model.
- [ ] Leave clear extension points for drag-to-reparent and inline node editing.
- [ ] Leave clear extension points for alternate layouts such as radial, left-to-right, and org-chart styles.

## Acceptance Criteria

- [ ] A user can open or type a Markdown nested list and enable Mindmap view without changing the Markdown source.
- [ ] The Mindmap pane renders a readable diagram with nodes, connectors, branch colours, and correct hierarchy.
- [ ] The Mindmap pane supports explicit node colours and at least one graphics mechanism.
- [ ] The Mindmap pane remains readonly but clicking a node can locate the source line.
- [ ] The feature works in light and dark modes.
- [ ] The feature works in raw-only plus mindmap split usage.
- [ ] The feature handles empty or malformed input gracefully.
- [ ] Existing Preview and Mermaid Preview continue to work.
- [ ] Exporting the mindmap works for at least SVG.
- [ ] The implementation is documented enough in code/tests that a later editable v3 can build on the parser and data model.
