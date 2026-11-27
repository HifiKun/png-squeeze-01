# png-squeeze

A lossless PNG compressor for make.fun's `png-squeeze-01` bounty: it rewrites
1280×720 RGBA screenshots as the smallest PNG it can, every pixel exact.

## How it works

`main.ts` (Node 22, built-ins only, no network, deterministic) runs the whole
set of 8 screenshots in one run:

1. **Decode** the stored RGBA PNG.
2. **Analyse** the pixels: opaque? grey? how many distinct colours?
3. **Enumerate lossless forms**: palette (≤ 256 colours, count and luminance
   order), grey / grey+alpha, RGB / RGBA, and a tRNS-keyed form when the
   image has a single fully-transparent colour and is otherwise opaque.
4. **Filter plans** per form: fixed filters, per-row minimum-sum, per-row
   fewest-distinct-byte-pairs, and per-row brute force for palette forms
   (each of the five filters weighed by a small zlib run over the preceding
   32 KiB of filtered output).
5. **Screen** every plan with zlib level 6, keep the best two, re-compress
   them with zlib level 9 — plain, and block-split at 128 / 256 / 512 KiB
   (Z_BLOCK flushes, so each block gets fresh Huffman tables while LZ77
   matching still spans blocks) — and keep the smallest file overall.

## Local test

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Practice-set score with the kit's scorer: **709,805 / 1,000,000**
(house baseline fixed-paeth 1.0.0: 420,399), every instance answered,
two executions byte-identical, ~18 s for the set on one CPU.

## License

MIT — see `LICENSE`.
