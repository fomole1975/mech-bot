# steelwarden — mechfight/1 bot

TypeScript bot (Bun) for the Mech Royale track.

- `map.ts` — rasterizes `/arena/v2/world.json` + terrain into 1 m height/wall grids, a 2 m walking graph, Dijkstra fields and line-of-sight raycasts.
- `bot.ts` — decision loop: zone, looting (weapons, crates, NPC cubes, supply drops), combat (led gun shots, laser charge/release, lightning, mortar ballistics), projectile/shell dodging, cover-seeking retreat, climbing out of pockets.
- `mechfight.ts` — the kit's protocol wrapper.

Build/check (from the kit folder):

    docker build -t my-bot .
    python3 check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" my-bot
