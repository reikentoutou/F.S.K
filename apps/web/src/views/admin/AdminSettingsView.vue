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
import { onMounted, reactive, shallowRef } from 'vue';

import { DataRepositoryError } from '@/data/errors';
import { ownerMasterDataRepository } from '@/data/master-data';

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
  if (!name) return;
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
  }
}

async function setShiftActive(row: ShiftRow, active: boolean): Promise<void> {
  if (!active && !(await confirmDeactivation(row.name, 'シフト'))) return;
  try {
    await updateOwnerShiftActive(row, active, ownerMasterDataRepository);
    ElMessage.success(active ? 'シフトを有効にしました' : 'シフトを無効にしました');
    await load();
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, 'シフトの更新に失敗しました'));
  }
}

async function addPerson(): Promise<void> {
  const name = newPerson.value.trim();
  if (!name) return;
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
  }
}

async function setPersonActive(row: PersonRow, active: boolean): Promise<void> {
  if (!active && !(await confirmDeactivation(row.name, '責任者'))) return;
  try {
    await updateOwnerPersonActive(row, active, ownerMasterDataRepository);
    ElMessage.success(active ? '責任者を有効にしました' : '責任者を無効にしました');
    await load();
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, '責任者の更新に失敗しました'));
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
      <p class="section-hint">無効化しても、過去の日報に保存されたシフト名は削除されません。</p>
      <el-table :data="shifts" size="small" class="settings-table">
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="sortOrder" label="表示順" width="90" />
        <el-table-column label="状態" width="90">
          <template #default="{ row }">{{ row.active ? '有効' : '無効' }}</template>
        </el-table-column>
        <el-table-column label="" width="110" align="right">
          <template #default="{ row }">
            <el-button
              link
              :type="row.active ? 'danger' : 'primary'"
              @click="setShiftActive(row, !row.active)"
            >
              {{ row.active ? '無効化' : '再有効化' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="mobile-master-list">
        <article v-for="shift in shifts" :key="shift.id" class="mobile-master-row">
          <div class="mobile-master-copy">
            <strong>{{ shift.name }}</strong>
            <span>表示順 {{ shift.sortOrder }} · {{ shift.active ? '有効' : '無効' }}</span>
          </div>
          <el-button
            :type="shift.active ? 'danger' : 'primary'"
            plain
            @click="setShiftActive(shift, !shift.active)"
          >
            {{ shift.active ? '無効化' : '再有効化' }}
          </el-button>
        </article>
      </div>
      <div class="add-row">
        <el-input v-model="newShift.name" placeholder="新規シフト名" class="name-input" />
        <el-input-number v-model="newShift.sortOrder" :min="0" aria-label="表示順" />
        <el-button type="primary" @click="addShift">追加</el-button>
      </div>
    </section>

    <section class="settings-section" aria-labelledby="setting-persons">
      <h3 id="setting-persons">責任者</h3>
      <p class="section-hint">無効化しても、過去の日報に保存された責任者名は削除されません。</p>
      <el-table :data="persons" size="small" class="settings-table">
        <el-table-column prop="name" label="名前" min-width="160" />
        <el-table-column label="状態" width="90">
          <template #default="{ row }">{{ row.active ? '有効' : '無効' }}</template>
        </el-table-column>
        <el-table-column label="" width="110" align="right">
          <template #default="{ row }">
            <el-button
              link
              :type="row.active ? 'danger' : 'primary'"
              @click="setPersonActive(row, !row.active)"
            >
              {{ row.active ? '無効化' : '再有効化' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="mobile-master-list">
        <article v-for="person in persons" :key="person.id" class="mobile-master-row">
          <div class="mobile-master-copy">
            <strong>{{ person.name }}</strong>
            <span>{{ person.active ? '有効' : '無効' }}</span>
          </div>
          <el-button
            :type="person.active ? 'danger' : 'primary'"
            plain
            @click="setPersonActive(person, !person.active)"
          >
            {{ person.active ? '無効化' : '再有効化' }}
          </el-button>
        </article>
      </div>
      <div class="add-row">
        <el-input v-model="newPerson" placeholder="新規名前" class="name-input" />
        <el-button type="primary" @click="addPerson">追加</el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-page { display: grid; gap: 24px; }
.settings-section { padding: 18px 20px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
.settings-section h3 { margin: 0 0 12px; }
.section-hint { margin: 0 0 10px; font-size: 13px; color: var(--el-text-color-secondary); line-height: 1.45; }
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
  .mobile-master-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; padding: 11px 12px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-sm); background: var(--fs-surface); }
  .mobile-master-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
  .mobile-master-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-master-copy span { color: var(--fs-muted); font-size: 0.75rem; }
  .mobile-master-row .el-button { min-height: 40px; flex-shrink: 0; }
  .add-row { display: grid; grid-template-columns: 1fr; }
  .add-row > *, .name-input, .add-row :deep(.el-input-number) { width: 100%; max-width: none; }
  .add-row > .el-button { min-height: 44px; }
}
</style>
