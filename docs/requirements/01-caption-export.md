# Feature 1: Reliable caption export

Status: Accepted — the user confirmed that repairing the existing independent
SRT/VTT export satisfies feature 1. Implementation: 4.3.1.

## User goal

Export a timed transcript suitable for uploading to YouTube alongside the edited video.

## Confirmed context

- The user initially could not find the existing caption export feature.
- The application already exposes a **Captions** button beside **Export .mp4**.
- The existing exporter offers SRT and WebVTT through a native save dialog.
- The user tried this action and received:

  > Caption export failed: Command plugin:fs|write_text_file not allowed by ACL

## Diagnosed defect

`src/components/Toolbar/Toolbar.tsx` invokes the filesystem plugin's
`writeTextFile` function, which requires `fs:allow-write-text-file`.
`src-tauri/capabilities/default.json` currently grants `fs:allow-write-file`,
which enables a different command and does not authorize text-file writes.

The installed Tauri dialog plugin already adds the exact file selected by the
save dialog to the filesystem scope. The missing command permission is a build
configuration defect. A separate macOS permission prompt does not resolve this
specific ACL rejection.

References:

- [Tauri filesystem permissions](https://v2.tauri.app/plugin/file-system/)
- [YouTube supported caption formats](https://support.google.com/youtube/answer/2734698?hl=en)

## Accepted scope

These requirements preserve the existing workflow while repairing the reported failure.

1. A user with a transcript can use **Captions**, choose SRT or VTT, and save
   the generated UTF-8 text at the location selected in the native save dialog.
2. The app declares the text-write command permission for its main window.
   The fix must not add blanket filesystem path access; export relies on the
   save dialog's grant for the selected destination.
3. Successful writes show the existing success notification and destination.
4. Cancelling the save dialog creates no file and shows no failure notification.
5. Actual write failures remain visible and must not be reported as success.
6. Caption export does not change source media, the edit decisions, or the
   project's transcript text.
7. Retain the existing caption generation, grouping, and output-time mapping.
   This repair changes command authorization only.

## Acceptance checks

- Save an SRT file to a location selected through the save dialog; confirm
  that the file contains numbered cues and SRT timestamps.
- Save a VTT file the same way; confirm that the file starts with `WEBVTT`
  and contains WebVTT timestamps.
- Confirm that technical terminology, punctuation, and non-ASCII text survive
  export without corruption.
- Confirm that cancelling does not write a file or report an error.
- Confirm that a genuinely unavailable destination reports failure.
- Confirm that the implementation grants the missing command without adding
  broad directory scopes.
- Rebuild and restart the native application before checking the ACL repair;
  an already-installed app does not pick up repository capability changes.

## Scope boundaries

The existing Captions action, label, native save dialog, automatic caption
breaks, and behavior for partially transcribed projects remain as implemented.
This feature does not add an export-video checkbox, automatic paired exports,
untimed transcript documents, or manual caption timing controls.

The earlier draft proposed a broader rendered-video synchronization check.
The user accepted a permission repair, so timing algorithm changes are outside
this implementation. Existing unit tests cover output-time mapping after
deletions; they do not establish synchronization against rendered video.
The video exporter's cut-point padding and possible caption drift remain a
separate verification concern.

## Separate features

Manual transcript corrections and script-assisted terminology/capitalization
corrections will have their own requirements documents and implementations.
This document does not add those behaviors or define their interactions yet.

## Implementation verification

- `npm test -- tests/captions.test.ts`: all 10 existing caption tests pass.
- `tauri build --ci --bundles app -- --locked --offline`: frontend type checking,
  production frontend build, native release compilation, and macOS app bundling
  pass.
- The generated native capabilities include `fs:allow-write-text-file`; both
  capability files add only that permission and no directory scopes.
- Application and lockfile versions consistently identify this fix as 4.3.1.
- Native save-dialog smoke checks remain to be performed in the rebuilt app.
  The previously installed/running app was not replaced or closed.
