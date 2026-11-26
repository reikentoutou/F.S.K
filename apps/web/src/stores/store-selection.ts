import { shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { type StoreScope } from '@fsk/domain';

export const useStoreSelection = defineStore('store-selection', () => {
  const selected = shallowRef<StoreScope>('02');
  function select(value: StoreScope) {
    if (value !== 'all' && value !== '02' && value !== '03') throw new Error('STORE_FORBIDDEN');
    selected.value = value;
  }
  return { selected, select };
});
