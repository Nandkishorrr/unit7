# Unit 7 website

The public site for Unit 7 by Signull. Static Astro, three pages: Home, V2 and Open source.

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static site in dist/
npm run preview  # serve dist/ locally
```

## Change the URLs

- Repo, Signull site, coffee link: `src/site.ts`. Everything reads from there, including the install commands and `llms.txt`.
- The site's own address is also in `astro.config.mjs`, `public/robots.txt` and `public/sitemap.xml`.

## Where things are

- `src/pages/`: the pages. `index.astro` is Home.
- `src/components/`: `RealUse`, `Environments` and `TalkToMap` are the three big Home sections. `Code` is the terminal card.
- `src/scripts/shader.ts`: the one WebGL canvas behind every page.
- `src/scripts/motion.ts`: what every page shares (wipes, nav, moods, Warden, tabs, the pause).
- `src/scripts/home.ts`, `real.ts`, `v2.ts`: page behaviour. Pages are complete without them.
- `src/styles/global.css`: tokens and shared styles.

## The one rule

Every diagonal uses the 7's angle: `dx/dy = 0.62`, 31.8 degrees from vertical. Product mocks stay rounded.

## Keeping it true

Every section of the V2.1 page carries a status (`Done`, `In testing`, `In progress`) in `src/pages/v2.astro`. Screenshots and mocks use a demo workspace only.

The newest version's name is one line: `LATEST` in `src/site.ts`. The film is in `public/film`, compressed from `launch-video/out/unit7-launch-v2.mp4`.
