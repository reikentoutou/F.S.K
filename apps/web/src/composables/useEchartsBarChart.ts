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
    if (resizeListenerAttached) {
      window.removeEventListener('resize', resize);
      resizeListenerAttached = false;
    }
    disposeChart();
  });

  return { setBarData, resize };
}
