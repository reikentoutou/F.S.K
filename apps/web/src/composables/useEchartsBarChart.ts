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
  let chartHost: HTMLDivElement | null = null;
  let resizeListenerAttached = false;

  function disposeChart(): void {
    chart.value?.dispose();
    chart.value = null;
    chartHost = null;
  }

  function ensureChart(): echarts.ECharts | null {
    const nextHost = chartEl.value;
    if (!nextHost) {
      disposeChart();
      return null;
    }
    if (chart.value && chartHost !== nextHost) {
      disposeChart();
    }
    if (!chart.value) {
      chart.value = echarts.init(nextHost);
      chartHost = nextHost;
      if (!resizeListenerAttached) {
        window.addEventListener('resize', resize);
        resizeListenerAttached = true;
      }
    }
    return chart.value;
  }

  function setBarData(categories: string[], series: BarChartSeries[]) {
    const instance = ensureChart();
    if (!instance) return;
    instance.resize();
    instance.setOption({
      color: ['#2563eb'],
      grid: { top: 16, right: 20, bottom: 16, left: 12, containLabel: true },
      tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => `${Number(value).toLocaleString('ja-JP')} 円` },
      xAxis: { type: 'value', axisLabel: { color: '#525866', fontSize: 10 }, splitLine: { lineStyle: { color: '#e2e5eb' } } },
      yAxis: {
        type: 'category',
        inverse: true,
        data: categories,
        axisLabel: { color: '#525866', fontSize: 11, width: 100, overflow: 'break' },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'bar',
        barMaxWidth: 24,
        itemStyle: { borderRadius: [0, 3, 3, 0] },
        data: s.data,
      })),
    });
  }

  function resize() {
    chart.value?.resize();
  }

  onBeforeUnmount(() => {
    if (resizeListenerAttached) {
      window.removeEventListener('resize', resize);
      resizeListenerAttached = false;
    }
    disposeChart();
  });

  return { setBarData, resize };
}
