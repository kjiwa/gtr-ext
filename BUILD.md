# Building

These are instructions for building the extension from source. If you just
want to use the extension, download a prebuilt release instead — see
[Installation](README.md#installation) in the README.

## Prerequisites

- [Node.js](https://nodejs.org/) (tested with v24) and npm
- git

## Install dependencies

```sh
git clone https://github.com/nelsonjchen/gtr-ext.git
cd gtr-ext
npm install
```

## Build

The extension is bundled with [esbuild](https://esbuild.github.io/) from two
entry points: `src/background.ts` (the MV3 service worker) and
`src/popup.tsx` (the React popup UI). Output is written to `public/build/`.

```sh
npm run build
```

For a production build without source maps:

```sh
NODE_ENV=production npm run build
```

To rebuild automatically as you edit source files:

```sh
npm run build:watch
```

## Load the unpacked extension

The loadable extension is the entire `public/` folder — it contains
`manifest.json`, `popup.html`, the icons, and the `build/` output produced
above.

1. Run `npm run build` (or `build:watch`) at least once so `public/build/`
   exists.
2. In Chrome, go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `public/` folder in this repo.
5. Find the Rocket icon in the extensions menu and click it to open the popup.

## Development loop

Run `npm run build:watch` in a terminal, make your changes, then click the
reload icon for the extension on `chrome://extensions` to pick up the new
build. If you change `public/manifest.json` or `public/popup.html`, reload the
extension the same way (these files are used as-is, not bundled).

## Testing and formatting

```sh
npm test          # run the Jest test suite once
npm run test:watch
npm run fmt        # format with Prettier
npm run fmt:check  # check formatting without writing changes
```

Prettier also runs automatically as a pre-commit hook (via `yorkie`).

## Packaging a release zip

```sh
npm run build
npm run pkg
```

This zips the contents of `public/` into `gtr-ext-unpacked.zip` at the repo
root — the same "unpacked" zip format described in the README's
[Installation](README.md#installation) section.
