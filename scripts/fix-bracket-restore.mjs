import { readFileSync, writeFileSync } from 'fs';

const file = 'src/components/admin/BracketDraw.tsx';
let content = readFileSync(file, 'utf8');

// Find and replace the sequential-slice block with balancedDistribute
const oldBlock = `          // Rebuild teamsByGroup: drawn brackets keep their revealed teams;
          // undrawn brackets are filled from the remaining ID-filtered pool
          // so the draw animation has real teams to drop in (not empty arrays).
          const _undrawnPool = safeTeams.filter((t) => !_cachedIds.has(t.id));
          let _poolIdx = 0;
          const buckets: Team[][] = existingDrawn.map((g) => {
            const revealed = g.slots.map((s) => s.team).filter((t): t is Team => t !== null);
            if (revealed.length > 0 || g.isDrawn) {
              return revealed;
            }
            // Undrawn bracket \u2014 assign next N teams from the remaining pool
            const count = g.slots.length;
            const assigned = _undrawnPool.slice(_poolIdx, _poolIdx + count);
            _poolIdx += count;
            return assigned;
          });

          setTeamsByGroup(buckets);`;

const newBlock = `          // Rebuild teamsByGroup: drawn brackets keep their revealed teams;
          // undrawn brackets use balancedDistribute so the seeding constraint
          // (one seeded team per bracket) is maintained mid-draw.
          // Sequential slicing clusters seeded teams into the same bracket.
          const _undrawnPool = safeTeams.filter((t) => !_cachedIds.has(t.id));
          const _undrawnCount = existingDrawn.filter(
            (g) => !g.isDrawn && g.slots.every((s) => s.team === null)
          ).length;
          const _undrawnBuckets =
            _undrawnCount > 0 ? balancedDistribute(_undrawnPool, _undrawnCount) : [];
          let _ubIdx = 0;
          const buckets: Team[][] = existingDrawn.map((g) => {
            const revealed = g.slots.map((s) => s.team).filter((t): t is Team => t !== null);
            if (revealed.length > 0 || g.isDrawn) {
              return revealed;
            }
            return _undrawnBuckets[_ubIdx++] ?? [];
          });

          setTeamsByGroup(buckets);`;

if (!content.includes(oldBlock)) {
  console.error('Target block NOT found. Dumping surrounding area for debug...');
  const idx = content.indexOf('_undrawnPool');
  console.log(JSON.stringify(content.slice(idx - 20, idx + 600)));
  process.exit(1);
}

content = content.replace(oldBlock, newBlock);
writeFileSync(file, content, 'utf8');
console.log('Done — replaced sequential slice with balancedDistribute for undrawn brackets.');
