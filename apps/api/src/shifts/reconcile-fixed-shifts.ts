import type { Prisma } from '@prisma/client';
import { FIXED_SHIFTS } from './fixed-shifts';

export async function reconcileFixedShifts(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const existingShifts = await tx.shift.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const activeFixedIds = new Set<string>();

  for (const fixedShift of FIXED_SHIFTS) {
    const existing = existingShifts.find(
      (shift) => shift.name === fixedShift.name && !activeFixedIds.has(shift.id),
    );
    if (existing) {
      activeFixedIds.add(existing.id);
      await tx.shift.update({
        where: { id: existing.id },
        data: { sortOrder: fixedShift.sortOrder, active: true },
      });
      continue;
    }

    const created = await tx.shift.create({
      data: {
        name: fixedShift.name,
        sortOrder: fixedShift.sortOrder,
        active: true,
      },
    });
    activeFixedIds.add(created.id);
  }

  for (const shift of existingShifts) {
    if (activeFixedIds.has(shift.id) || !shift.active) continue;
    await tx.shift.update({
      where: { id: shift.id },
      data: { active: false },
    });
  }
}
