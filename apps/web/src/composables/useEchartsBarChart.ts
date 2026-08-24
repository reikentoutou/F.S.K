import { onBeforeUnmount, shallowRef, type Ref } from 'vue';
import * as echarts from 'echarts';

export type BarChartSeries = {
  name: string;
  data: number[];
};

export function useEchartsBarChart(
  chartEl: Readonly<Ref<HTMLDivElement | null>>,
) {
  const chart = shallowRef<echarts.ECharts | null>(null);

  function ensureChart(): echarts.ECharts | null {
    if (!chartEl.value) return null;
    if (!chart.value) {
      chart.value = echarts.init(chartEl.value);
      window.addEventListener('resize', resize);
    }
    return chart.value;
  }

  function setBarData(categories: string[], series: BarChartSeries[]) {
    const instance = ensureChart();
    if (!instance) return;
    instance.setOption({
      tooltip: {},
      xAxis: {
        type: 'category',
        data: categories,
      },
      yAxis: { type: 'value' },
      series: series.map((s) => ({
        name: s.name,
        type: 'bar',
        data: s.data,
      })),
    });
  }

  function resize() {
    chart.value?.resize();
  }

  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize);
    chart.value?.dispose();
    chart.value = null;
  });

  return { setBarData, resize };
}
