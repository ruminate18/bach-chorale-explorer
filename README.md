# Bach Chorale Explorer

**Live site:** https://ruminate18.github.io/bach-chorale-explorer/

A browser-based music-analysis tool for the 370 four-part chorales of J.S. Bach, built for the Music Theory / Musicology module.

## What it does

- **Ingests** the chorales' Humdrum `**kern` encodings into a local data store (IndexedDB in your browser). Each chorale is parsed into metadata (title, BWV, key, meter), the soprano melody, and an automatic Roman-numeral harmonic analysis. The **Re-ingest** button rebuilds the store.
- **Searches** three ways:
  - **Text**: German or English title, BWV number, or chorale number (`Jesu`, `BWV 269`, `12`).
  - **Melody**: a soprano interval pattern at any transposition, as note names (`G A B C`) or semitone steps (`+2 +2 +1`).
  - **Harmony**: a progression of Roman numerals relative to the home key (`ii V7 I`, `IV V I`, `V vi`).
- **Displays** each result in music notation (engraved with Verovio), with the matching notes highlighted in red.
- **Plays** any result in the browser, highlighting notes as they sound, and exports it as a **MIDI** file.
- Direct links to a chorale work, e.g. `#chor001`.

## How the harmonic analysis works

Every sonority where a new note begins (and that lasts at least an eighth note) is matched against major, minor and diminished triads and the common seventh chords. Sonorities that contain non-chord tones are skipped, and repeated labels are merged. The numerals are relative to the key at the start of the piece, so a modulation shows up as chromatic numerals (for example `II` for V/V). It is a heuristic, not an expert analysis.

## Running locally

It is a static site with no build step. Serve the folder with any static web server (for example `python3 -m http.server`) and open `http://localhost:8000`.

## Credits

- Chorale encodings: Craig Stuart Sapp, [bach-370-chorales](https://github.com/craigsapp/bach-370-chorales) (CC BY-NC-SA 4.0)
- Notation: [Verovio](https://www.verovio.org)

See [LICENSE](LICENSE).
