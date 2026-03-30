# Note Formatter AI

Note Formatter AI is a local Windows Node.js app for turning rough lecture notes into a cleaner A4 two-column PDF.

It can:

- build a formatting profile from one or more sample PDFs
- accept a raw notes PDF or screenshot image (`.png` / `.jpg`)
- generate a formatted PDF in a compact two-column layout
- optionally use Gemini for better structuring and OCR on screenshots or scanned pages
- preserve detected list markers such as `9.`, `10.`, `(i)`, `(ii)` instead of replacing everything with generic bullets

The browser UI is served at:

```text
http://localhost:3000
```

## Requirements

- Windows
- Node.js installed
- npm installed
- A modern browser

Tested in this workspace with:

- Node.js `v24.14.0`
- npm `11.9.0`

## Project layout

```text
note-formatter-ai/
|- backend/
|  |- app/
|  |- data/
|  `- server.js
|- package.json
|- package-lock.json
`- start-note-formatter.cmd
```

Important runtime folders:

- `backend/data/style_samples` stores reference PDFs used to build the style profile
- `backend/data/exports` stores generated output PDFs
- `backend/data/uploads` stores temporary uploads during processing
- `backend/data/raw` stores temporary extracted image assets during processing

## Quick start

If you just want to launch the app on Windows, run:

```bat
start-note-formatter.cmd
```

That script:

- starts the server in a separate PowerShell window
- opens the browser automatically at `http://localhost:3000`

Important:

- keep the PowerShell window open while using the app
- if you close that window, the server stops and the browser will show `ERR_CONNECTION_REFUSED`

## Manual run

### Command Prompt

Open Command Prompt and run:

```bat
cd /d C:\Users\rayan\OneDrive\Desktop\notesAutomation\note-formatter-ai
npm install
npm start
```

When the server is ready, you should see:

```text
note-formatter-ai listening on http://localhost:3000
```

Then open:

```text
http://localhost:3000
```

Stop the server with:

```text
Ctrl + C
```

### PowerShell

If PowerShell blocks `npm`, use:

```powershell
cd C:\Users\rayan\OneDrive\Desktop\notesAutomation\note-formatter-ai
npm.cmd install
npm.cmd start
```

Or use the launcher:

```powershell
.\start-note-formatter.cmd
```

## Optional environment variables

You can run the app without a Gemini key. The key can also be entered directly in the UI.

Set variables in the current terminal session like this:

```bat
set GEMINI_API_KEY=your_key_here
set GEMINI_MODEL=gemini-2.5-flash
set PORT=3000
```

Notes:

- `GEMINI_API_KEY` is optional
- `GEMINI_MODEL` defaults to `gemini-2.5-flash`
- `PORT` defaults to `3000`

Use Gemini when:

- the uploaded PDF contains screenshots instead of selectable text
- the uploaded file is a screenshot image
- equations or derivations need OCR before formatting

## How to use the app

1. Upload one or more style sample PDFs in the `Formatting Profile` section.
2. Click `Rebuild profile` if you want to refresh the default style profile.
3. Upload a raw notes PDF or screenshot image in `Generate Formatted Notes`.
4. Optionally add extra style PDFs for that one formatting run.
5. Optionally add a Gemini API key and custom instructions.
6. Click `Format PDF`.
7. Download the generated PDF from the result card.

## Current behavior

- The formatter tries to keep detected numbering and sub-numbering from the source notes.
- If Gemini is not provided, the app still formats the document using local heuristics.
- If a PDF contains problematic embedded image objects that never resolve, the formatter now skips those unresolved objects instead of hanging forever.
- OCR is only available when Gemini is used on image-based content.

## Available scripts

From the project root:

```bat
npm start
npm run dev
npm run rebuild-profile
npm run smoke
```

What they do:

- `npm start` starts the production server
- `npm run dev` starts the server with Node watch mode
- `npm run rebuild-profile` rebuilds the default style profile
- `npm run smoke` runs the smoke test script

## Troubleshooting

### `localhost:3000` says `ERR_CONNECTION_REFUSED`

The server is not running.

Fix:

```bat
cd /d C:\Users\rayan\OneDrive\Desktop\notesAutomation\note-formatter-ai
npm start
```

Or run:

```bat
start-note-formatter.cmd
```

Keep that terminal window open, then refresh the browser tab.

### Port 3000 is already in use

Start the app on another port:

```bat
set PORT=3001
npm start
```

Then open:

```text
http://localhost:3001
```

### PowerShell says scripts are disabled

Use:

```powershell
npm.cmd install
npm.cmd start
```

### Formatting falls back without Gemini

This is expected for text-only local processing. The output can still be good, but Gemini usually helps more with:

- scanned pages
- screenshot-heavy notes
- OCR of text inside images

### Some images from a PDF do not appear in the output

If a source PDF contains broken or unresolved embedded image objects, the app skips those image objects instead of getting stuck. Text extraction and PDF generation will still continue.
