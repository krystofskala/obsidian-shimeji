# The plant room's artwork

Currently nothing to put here: **the plant room**, the only room style on offer right now, is drawn
by the plugin itself and needs no picture file.

This folder — and the settings dropdown's per-style `imageBase` field — exist for a future
supplied-artwork room (an "Apartment" or "Cellar" style once lived here, since removed). Adding one
back means a new `src/room/<name>.ts` `RoomDef`, an entry in `src/room/rooms.ts`'s `ROOM_STYLES`,
and dropping its picture (`.png`/`.webp`/`.jpg`/`.jpeg`/`.gif` all work) in this same folder under
whatever `imageBase` names it.

## Making the shimeji stand on the furniture

However a room's own surfaces are authored (in percentages of the room's width — see
`src/room/roomDef.ts`'s `RoomFixture`), they are the one part that cannot be checked by reasoning
alone when the room is supplied artwork: the plugin draws a self-drawn room's picture and its
collision lines from the same declaration, so those cannot disagree, but an image knows nothing
about lines placed on top of it.

So look at them instead. Run **"Show/hide what the shimeji can stand on in the plant room"** and
the surfaces are drawn over the room:

- **solid green** — floors, things it stands on
- **dashed amber** — ceilings, things it hangs from
- **blue** — walls, things it climbs
