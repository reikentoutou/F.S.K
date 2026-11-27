<script lang="ts">
import { DataRepositoryError as RepositoryError } from '@/data/errors';

export async function loadOwnerSettings<Shift, Person>(repository: {
  getSetting(id: string): Promise<{ registerFloatAmount: number }>;
  listShifts(): Promise<Shift[]>;
  listResponsiblePersons(): Promise<Person[]>;
}): Promise<{
  settingExists: boolean;
  registerFloatAmount: number;
  shifts: Shift[];
  persons: Person[];
}> {
  const setting = await repository.getSetting('default').catch((error: unknown) => {
    if (error instanceof RepositoryError && error.code === 'DATA_NOT_FOUND') {
      return null;
    }
    throw error;
  });
  const [shifts, persons] = await Promise.all([
    repository.listShifts(),
    repository.listResponsiblePersons(),
  ]);
  return {
    settingExists: setting !== null,
    registerFloatAmount: setting?.registerFloatAmount ?? 0,
    shifts,
    persons,
  };
}

export function updateOwnerShiftActive<T>(
  row: { id: string; name: string; sortOrder: number; active: boolean },
  active: boolean,
  repository: { updateShift(value: typeof row): Promise<T> },
): Promise<T> {
  return repository.updateShift({ ...row, active });
}

export function updateOwnerPersonActive<T>(
  row: { id: string; name: string; active: boolean },
  active: boolean,
  repository: { updateResponsiblePerson(value: typeof row): Promise<T> },
): Promise<T> {
  return repository.updateResponsiblePerson({ ...row, active });
}
</script>

<script setup lang="ts">

import { ElMessage, ElMessageBox } from 'element-plus';
import { onBeforeUnmount, onMounted, reactive, shallowRef } from 'vue';

import { DataRepositoryError } from '@/data/errors';
import { useStoreSelection } from '@/stores/store-selection';
import { createOwnerMasterDataRepository } from '@/data/master-data';
const storeScope = useStoreSelection().selected;
const ownerMasterDataRepository = createOwnerMasterDataRepository(undefined, storeScope);

type ShiftRow = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
};

type PersonRow = {
  id: string;
  name: string;
  active: boolean;
};

function ownerDataErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof DataRepositoryError)) return fallback;
  switch (error.code) {
    case 'DATA_UNAUTHORIZED':
      return '権限がありません。ユーザーアカウントで再ログインしてください';
    case 'DATA_NOT_FOUND':
      return '指定した設定が見つかりません。更新または削除された可能性があります';
    case 'REPORT_ALREADY_EXISTS':
    case 'DATA_CONFLICT':
      return '設定が競合しました。画面を更新してもう一度お試しください';
    case 'DATA_PAGINATION_FAILED':
      return 'データの読み込みに失敗しました。もう一度お試しください';
    case 'DATA_NETWORK_ERROR':
    case 'SUBMISSION_RESULT_UNKNOWN':
      return 'ネットワークエラーが発生しました。接続を確認してもう一度お試しください';
    default:
      return fallback;
  }
}

const loading = shallowRef(true);
const savingFloat = shallowRef(false);
const settingExists = shallowRef(false);
const registerFloat = shallowRef(0);
const shifts = shallowRef<ShiftRow[]>([]);
const persons = shallowRef<PersonRow[]>([]);
const newShift = reactive({ name: '', sortOrder: 10 });
const newPerson = shallowRef('');
const pendingMaster = shallowRef<string | null>(null);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });

async function removeMaster(row: ShiftRow | PersonRow, kind: 'shift' | 'person'): Promise<void> {
  if (loading.value || pendingMaster.value || disposed) return;
  const label = kind === 'shift' ? 'シフト' : '責任者';
  pendingMaster.value = `${kind}:${row.id}`;
  try {
    try {
      await ElMessageBox.confirm(
        `「${row.name}」を削除しますか？元に戻せません。既存の日報と保存済みの名称は残ります。`,
        `${label}を削除`,
        { confirmButtonText: '削除する', cancelButtonText: 'キャンセル', type: 'warning' },
      );
    } catch {
      return;
    }
    if (disposed) return;
    if (kind === 'shift') {
      await ownerMasterDataRepository.deleteShift(row.id);
      if (!disposed) shifts.value = shifts.value.filter((shift) => shift.id !== row.id);
    } else {
      await ownerMasterDataRepository.deleteResponsiblePerson(row.id);
      if (!disposed) persons.value = persons.value.filter((person) => person.id !== row.id);
    }
    if (!disposed) ElMessage.success(`${label}を削除しました`);
  } catch (error: unknown) {
    if (!disposed) ElMessage.error(ownerDataErrorMessage(error, `${label}の削除に失敗しました`));
  } finally {
    pendingMaster.value = null;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const loaded = await loadOwnerSettings(ownerMasterDataRepository);
    registerFloat.value = loaded.registerFloatAmount;
    settingExists.value = loaded.settingExists;
    shifts.value = loaded.shifts
      .filter((shift): shift is NonNullable<typeof shift> => shift != null)
      .map((shift) => ({
        id: shift.id,
        name: shift.name,
        sortOrder: shift.sortOrder,
        active: shift.active,
      }))
      .sort((left, right) => left.sortOrder - right.sortOrder);
    persons.value = loaded.persons
      .filter((person): person is NonNullable<typeof person> => person != null)
      .map((person) => ({
        id: person.id,
        name: person.name,
        active: person.active,
      }));
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, 'マスタの読み込みに失敗しました'));
  } finally {
    loading.value = false;
  }
}

async function saveFloat(): Promise<void> {
  savingFloat.value = true;
  try {
    const setting = {
      id: 'default',
      registerFloatAmount: registerFloat.value,
      setupCompleted: true,
    };
    if (settingExists.value) {
      await ownerMasterDataRepository.updateSetting(setting);
    } else {
      await ownerMasterDataRepository.createSetting(setting);
      settingExists.value = true;
    }
    ElMessage.success('レジ底銭を保存しました');
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, 'レジ底銭の保存に失敗しました'));
  } finally {
    savingFloat.value = false;
  }
}

async function addShift(): Promise<void> {
  const name = newShift.name.trim();
  if (!name || loading.value || pendingMaster.value || disposed) return;
  pendingMaster.value = 'shift:new';
  try {
    await ownerMasterDataRepository.createShift({
      id: `shift_${crypto.randomUUID()}`,
      name,
      sortOrder: newShift.sortOrder,
      active: true,
    });
    newShift.name = '';
    ElMessage.success('シフトを追加しました');
    await load();
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, 'シフトの追加に失敗しました'));
  } finally {
    pendingMaster.value = null;
  }
}

async function setShiftActive(row: ShiftRow, active: boolean): Promise<void> {
  if (loading.value || pendingMaster.value || disposed) return;
  pendingMaster.value = `shift:${row.id}:active`;
  try {
    if (!active && !(await confirmDeactivation(row.name, 'シフト'))) return;
    if (disposed) return;
    await updateOwnerShiftActive(row, active, ownerMasterDataRepository);
    ElMessage.success(active ? 'シフトを有効にしました' : 'シフトを無効にしました');
    await load();
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, 'シフトの更新に失敗しました'));
  } finally {
    pendingMaster.value = null;
  }
}

async function addPerson(): Promise<void> {
  const name = newPerson.value.trim();
  if (!name || loading.value || pendingMaster.value || disposed) return;
  pendingMaster.value = 'person:new';
  try {
    await ownerMasterDataRepository.createResponsiblePerson({
      id: `person_${crypto.randomUUID()}`,
      name,
      active: true,
    });
    newPerson.value = '';
    ElMessage.success('責任者を追加しました');
    await load();
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, '責任者の追加に失敗しました'));
  } finally {
    pendingMaster.value = null;
  }
}

async function setPersonActive(row: PersonRow, active: boolean): Promise<void> {
  if (loading.value || pendingMaster.value || disposed) return;
  pendingMaster.value = `person:${row.id}:active`;
  try {
    if (!active && !(await confirmDeactivation(row.name, '責任者'))) return;
    if (disposed) return;
    await updateOwnerPersonActive(row, active, ownerMasterDataRepository);
    ElMessage.success(active ? '責任者を有効にしました' : '責任者を無効にしました');
    await load();
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, '責任者の更新に失敗しました'));
  } finally {
    pendingMaster.value = null;
  }
}

async function confirmDeactivation(name: string, kind: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      `「${name}」を無効にしますか？既存の日報に保存された名称は残ります。`,
      `${kind}を無効化`,
      {
        confirmButtonText: '無効にする',
        cancelButtonText: 'キャンセル',
        type: 'warning',
      },
    );
    return true;
  } catch {
    return false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="settings-page">
    <section class="settings-section" aria-labelledby="setting-float">
      <h3 id="setting-float">レジ底銭</h3>
      <div class="add-row">
        <el-input-number v-model="registerFloat" :min="0" :step="1000" />
        <el-button type="primary" :loading="savingFloat" @click="saveFloat">保存</el-button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="setting-shifts">
      <h3 id="setting-shifts">シフト</h3>
      <el-table :data="shifts" size="small" class="settings-table">
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="sortOrder" label="表示順" width="90" />
        <el-table-column label="状態" width="90">
          <template #default="{ row }">{{ row.active ? '有効' : '無効' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="right">
          <template #default="{ row }">
            <el-button
              link
              :type="row.active ? 'danger' : 'primary'"
              :disabled="pendingMaster !== null"
              @click="setShiftActive(row, !row.active)"
            >
              {{ row.active ? '無効化' : '再有効化' }}
            </el-button>
            <el-button link type="danger" :aria-label="`${row.name}を削除`"
              :loading="pendingMaster === `shift:${row.id}`" :disabled="pendingMaster !== null"
              @click="removeMaster(row, 'shift')">削除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="mobile-master-list">
        <article v-for="shift in shifts" :key="shift.id" class="mobile-master-row">
          <div class="mobile-master-copy">
            <strong>{{ shift.name }}</strong>
            <span>表示順 {{ shift.sortOrder }} · {{ shift.active ? '有効' : '無効' }}</span>
          </div>
          <div class="master-actions">
            <el-button
              :type="shift.active ? 'danger' : 'primary'"
              plain
              :disabled="pendingMaster !== null"
              @click="setShiftActive(shift, !shift.active)"
            >
              {{ shift.active ? '無効化' : '再有効化' }}
            </el-button>
            <el-button type="danger" plain :aria-label="`${shift.name}を削除`"
              :loading="pendingMaster === `shift:${shift.id}`" :disabled="pendingMaster !== null"
              @click="removeMaster(shift, 'shift')">削除</el-button>
          </div>
        </article>
      </div>
      <div class="add-row">
        <el-input v-model="newShift.name" placeholder="新規シフト名" class="name-input" />
        <el-input-number v-model="newShift.sortOrder" :min="0" aria-label="表示順" />
        <el-button type="primary" :disabled="pendingMaster !== null" @click="addShift">追加</el-button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="setting-persons">
      <h3 id="setting-persons">責任者</h3>
      <el-table :data="persons" size="small" class="settings-table">
        <el-table-column prop="name" label="名前" min-width="160" />
        <el-table-column label="状態" width="90">
          <template #default="{ row }">{{ row.active ? '有効' : '無効' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="right">
          <template #default="{ row }">
            <el-button
              link
              :type="row.active ? 'danger' : 'primary'"
              :disabled="pendingMaster !== null"
              @click="setPersonActive(row, !row.active)"
            >
              {{ row.active ? '無効化' : '再有効化' }}
            </el-button>
            <el-button link type="danger" :aria-label="`${row.name}を削除`"
              :loading="pendingMaster === `person:${row.id}`" :disabled="pendingMaster !== null"
              @click="removeMaster(row, 'person')">削除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="mobile-master-list">
        <article v-for="person in persons" :key="person.id" class="mobile-master-row">
          <div class="mobile-master-copy">
            <strong>{{ person.name }}</strong>
            <span>{{ person.active ? '有効' : '無効' }}</span>
          </div>
          <div class="master-actions">
            <el-button
              :type="person.active ? 'danger' : 'primary'"
              plain
              :disabled="pendingMaster !== null"
              @click="setPersonActive(person, !person.active)"
            >
              {{ person.active ? '無効化' : '再有効化' }}
            </el-button>
            <el-button type="danger" plain :aria-label="`${person.name}を削除`"
              :loading="pendingMaster === `person:${person.id}`" :disabled="pendingMaster !== null"
              @click="removeMaster(person, 'person')">削除</el-button>
          </div>
        </article>
      </div>
      <div class="add-row">
        <el-input v-model="newPerson" placeholder="新規名前" class="name-input" />
        <el-button type="primary" :disabled="pendingMaster !== null" @click="addPerson">追加</el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-page { display: grid; gap: 12px; }
.settings-section { padding: 16px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
.settings-section h3 { margin: 0 0 12px; }
.settings-table { max-width: 680px; margin-bottom: 12px; }
.add-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.name-input { width: 240px; }
.mobile-master-list { display: none; }

@media (max-width: 720px) {
  .settings-page { gap: 12px; }
  .settings-section { padding: 16px 14px; }
  .settings-section h3 { font-size: 1rem; }
  .settings-table { display: none; }
  .mobile-master-list { display: grid; gap: 8px; margin-bottom: 12px; }
  .mobile-master-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; padding: 11px 12px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-sm); background: var(--fs-surface); }
  .mobile-master-copy { display: flex; flex: 1 1 110px; min-width: 0; flex-direction: column; gap: 3px; }
  .mobile-master-copy strong { overflow-wrap: anywhere; font-size: 14px; }
  .mobile-master-copy span { color: var(--fs-muted); font-size: 0.75rem; }
  .master-actions { display: flex; flex-shrink: 0; gap: 6px; margin-left: auto; }
  .master-actions .el-button { min-height: 44px; margin-left: 0; padding: 0 10px; }
  .add-row { display: grid; grid-template-columns: 1fr; }
  .add-row > *, .name-input, .add-row :deep(.el-input-number) { width: 100%; max-width: none; }
  .add-row > .el-button { min-height: 44px; }
}
</style>
