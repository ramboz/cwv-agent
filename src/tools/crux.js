import { cacheResults, getCachedResults } from '../utils.js';

// Helper function for consistent formatting and threshold checking
function checkMetric(metricName, value, good, needsImprovement) {
  needsImprovement = needsImprovement === undefined ? good * 2 : needsImprovement;
  if (value > needsImprovement) {
    return `* **${metricName}:** ${value} (Poor)\n`;
  } else if (value > good) {
    return `* **${metricName}:** ${value} (Needs Improvement)\n`;
  }
  return '';
}

export function summarize(cruxData) {
  if (!cruxData?.record?.metrics) {
    return 'No valid CrUX data available';
  }

  const m = cruxData.record.metrics;
  const url = cruxData.record.key.url;
  const formFactor = cruxData.record.key.formFactor;

  let report = `**URL:** ${url}\n**Form Factor:** ${formFactor}\n\n**Bottlenecks:**\n\n`;
  let hasBottlenecks = false;

  // Analyze Core Web Vitals and other metrics
  report += checkMetric('Largest Contentful Paint (LCP)', m.largest_contentful_paint?.percentiles?.p75, 2500, 4000);
  report += checkMetric('First Contentful Paint (FCP)', m.first_contentful_paint?.percentiles?.p75, 1800, 3000);
  report += checkMetric('Interaction to Next Paint (INP)', m.interaction_to_next_paint?.percentiles?.p75, 200, 500);
  report += checkMetric('Cumulative Layout Shift (CLS)', parseFloat(m.cumulative_layout_shift?.percentiles?.p75), 0.1, 0.25);
  report += checkMetric('Time to First Byte (TTFB)', m.experimental_time_to_first_byte?.percentiles?.p75, 800, 1800);
  report += checkMetric('Round Trip Time (RTT)', m.round_trip_time?.percentiles?.p75, 150, 600);


  // LCP Image Breakdown (if applicable)
  const lcpStatus = m.largest_contentful_paint?.percentiles?.p75 > 4000 ? 'Poor' :
                   m.largest_contentful_paint?.percentiles?.p75 > 2500 ? 'Needs Improvement' : 'Good';
  if (lcpStatus !== 'Good' && m.largest_contentful_paint_resource_type?.fractions?.image > 0.75) {
    report += `\n* **LCP Image Details:**\n`;
    report += `    *  Load Delay: ${m.largest_contentful_paint_image_resource_load_delay?.percentiles?.p75}ms\n`;
    report += `    *  Load Duration: ${m.largest_contentful_paint_image_resource_load_duration?.percentiles?.p75}ms\n`;
    report += `    *  Render Delay: ${m.largest_contentful_paint_image_element_render_delay?.percentiles?.p75}ms\n`;
    report += `    *  TTFB: ${m.largest_contentful_paint_image_time_to_first_byte?.percentiles?.p75}ms\n`;
  }

    // Check if any bottlenecks were found
    if (report.includes('(Poor)') || report.includes('(Needs Improvement)')) {
      hasBottlenecks = true;
    }

  // Add a 'No bottlenecks' message if everything is good
  if (!hasBottlenecks) {
    report += '* No significant bottlenecks found. Overall performance is good.\n';
  }

  return report;
}

export async function collect(pageUrl, deviceType, { skipCache }) {
  if (!skipCache) {
    const cache = getCachedResults(pageUrl, deviceType, 'crux');
    if (cache) {
      return { full: cache, summary: summarize(cache), fromCache: true };
    }
  }

  const resp = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${process.env.GOOGLE_CRUX_API_KEY}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: pageUrl,
      formFactor: deviceType === 'mobile' ? 'PHONE' : 'DESKTOP',
    }),
  });

  const json = await resp.json();
  cacheResults(pageUrl, deviceType, 'crux', json);
  const summary = summarize(json);
  cacheResults(pageUrl, deviceType, 'crux', summary);
  return { full: json, summary };
}
