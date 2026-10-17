# Muse AI Batch Image/Video Tool — Initial Specification

## Purpose

Build a Windows desktop tool that submits multiple image or video generation prompts to Muse using the user's own logged-in account, then downloads the results locally. Keep the design portable so a macOS version can be added later.

## Agreed requirements

- **First platform:** Windows. Keep platform-specific pieces isolated so macOS support can be added later.
- **Input:** The user can either paste a batch of prompts into the app or load a plain-text `.txt` file.
- **Batch format:** One prompt per line; each non-empty line is one job.
- **Media type:** Image or video is specified in the prompt itself. Support optional `ẢNH:` and `VIDEO:` prefixes to remove ambiguity. If the type cannot be determined, mark the row for user review instead of guessing.
- **Output naming:** Name each downloaded result from its prompt. Replace characters Windows does not allow in filenames, trim whitespace, and shorten overly long names. Add a sequence suffix when names collide.
- **Progress:** Show per-prompt status and allow the batch to continue when one job fails. Record failures so the user can retry those rows.
- **Authentication:** Use the user's local, already-authenticated browser session or another supported sign-in flow. Do not ask the user to paste or transmit session cookies.
- **Use:** Only automate the user's own account and respect Muse's usage limits and terms.

## Proposed workflow

1. User opens the tool and signs into Muse in their browser if needed.
2. User pastes prompts or selects a `.txt` file.
3. Tool previews parsed jobs and detected media types; user can correct any ambiguous rows.
4. User chooses an output folder and starts the batch.
5. Tool submits jobs in a controlled sequence, monitors completion, and downloads each result.
6. Tool names files from prompts and shows completed, failed, and retryable jobs.

## Decisions still open

- Preferred implementation/runtime for the Windows app.
- How the tool should connect to Muse: an official API if available, otherwise browser UI automation through a local session.
- Whether users need controls for image/video settings exposed by Muse (such as aspect ratio, duration, or quality).
- Whether to support multiple outputs per prompt.
- Whether the app should save a batch history and a retry file.
- Desired behavior when a prompt is missing a clear image/video indicator.

## Security and reliability notes

- Never store a raw session cookie in a config file or prompt the user to share it.
- Prefer an official Muse API or OAuth/session mechanism if Muse provides one. If browser automation is required, keep it local and expect UI changes to require maintenance.
- Add a configurable delay or concurrency limit to avoid overwhelming the service.
- Keep a per-job log with prompt, status, timestamp, and output path. Avoid logging credentials or sensitive browser data.
