# Saltline

> The port's security net has gone feral. Cut its three uplinks. Reach the boat.

A first-person shooter set in a container terminal at first light. It runs in the browser and is built on three.js.
Every surface, machine and sound is generated in code at runtime; the game downloads nothing but its fonts.

## Run it

```sh
npm install
npm run dev        # http://127.0.0.1:5280
npm run build      # production build into dist/ (relative paths: runs from any folder or static host)
npm run preview    # serve dist/ on http://127.0.0.1:5281
npm run format     # prettier over src/ and index.html
```

Controls (also on the title screen):

| Action | Keys |
| --- | --- |
| Move / look | WASD / mouse (click the view to capture it) |
| Fire / aim / reload | left / right mouse / R |
| Cut relay | E |
| Jump / sprint / crouch | Space / Shift / C |
| Pause | Esc |

There are also on-screen touch controls: left thumb moves, right thumb looks, plus fire, aim, reload and jump
buttons.

## Where this came from

Saltline was built on another device and published as a claude.ai artifact
(`https://claude.ai/artifact/BGY1SztrAYcJQHSsnHHGmp`). On 10 Nov 2026 the published page was unpacked into this
project:

| File | What it is |
| --- | --- |
| `index.html` | The page's markup: the canvas, the UI root and the boot card |
| `src/ui.css` | The game's whole interface style, as published (readable, with its section comments) |
| `src/game.js` | The game's code: the published bundle, formatted with prettier (about 59,600 lines) |
| `src/fonts.css`, `src/fonts/` | Big Shoulders Display, IBM Plex Mono and Barlow Condensed (OFL), hosted locally instead of loaded from Google Fonts |
| `public/favicon.svg` | A tab icon (the published page had none) |
| `reference/saltline-published.html` | The published page as one standalone file: claude.ai's frame runtime removed, fonts pointed at the local copies. Kept so it can be checked against the project |

What was removed: claude.ai's frame runtime (the published page's first two scripts, which only talk to the claude.ai
page around it; the game never calls them) and a claude.ai-only viewport meta tag.

### What this is not

The published page was a compiled, minified build with no source maps. So `src/game.js` is that build, formatted:
it runs exactly as published, but its local names are the minifier's (`fM`, `QC`, `M2`). The original source files
(TypeScript modules, the agents' docs) are not in it.

**The best next step is to bring the original project over from the device it was built on.** If it can't be
found, this project can be untangled gradually:
1. Swap the bundled three.js (r180, the first part of `src/game.js`) for the npm package.
2. Rename the game's own functions as they're understood.
3. Split the file into modules.

Run the game after each step.

Facts worth knowing when editing:
- Settings are saved in `localStorage` under `saltline.settings.v1`.
- The code runs as one self-starting function, `(() => { … })()`. The page loads it as a module script after the
  markup.

## Checks run on 10 Nov 2026

Each build was opened in headless Chrome (Metal, 1280×720), with DEPLOY clicked, then a walk and a shot:

| Build | Result |
| --- | --- |
| `npm run dev` | 60 fps, 0 console errors, no requests outside 127.0.0.1, all three fonts loaded locally; objective, compass, radio and ammo HUD working (30 → 27 after a burst) |
| `npm run build` + preview | the same |
| The standalone page in `reference/` | the same at the title screen |

Not checked: Safari, Firefox, touch devices, or a full playthrough.
