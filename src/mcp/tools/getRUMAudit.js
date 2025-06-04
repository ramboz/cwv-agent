import { loadBundles } from '../../utils.js';
import { series, DataChunks } from '@adobe/rum-distiller';

/**
 * Get the latest audit for a given site and audit type.
 * 
 * @param {string} siteId - UUID of the site.
 * @param {string} auditType - Audit type (e.g., 'cwv', 'lhs-desktop', etc.).
 * @param {object} [extraHeaders] - Optional additional headers (e.g., org ID, authorization).
 * @returns {Promise<object>} - The latest audit result.
 */
export async function getDataChunks(url, domainkey, startdate, enddate) {
    if (!url || !domainkey) {
        throw new Error('Both url and domainkey are required.');
    }
    let start, end;

    if (!startdate || !enddate) {
        start = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
        end = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    } else {
        start = new Date(startdate);
        end = new Date(enddate);
    }

    const dateList = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dateList.push(d.toISOString().slice(0, 10).replace(/-/g, '/'));
    }

    const allData = (await Promise.all(dateList.map(date => loadBundles(url, date, domainkey)))).flat();

    return allData;
}

/**
 * Get the relevant statistic for a DataChunk.
 * 
 * @param {string} dataChunks - Rum Bundle Datachunks.
 * @param {string} aggregation - Statistic Agent Needs (pageviews, lcp, inp, etc.).
 * @param {string} statistic - Statistic Agent Needs (max, mean, min, sum ).
 * @returns {Promise<object>} - The relevant statistic.
 */
export async function getStatistic(dataChunks, aggregation, statistic) {
    if (!dataChunks || !aggregation || !statistic) {
        throw new Error('dataChunks, aggregation, and statistic are required.');
    }

    let aggHandler;

    if (aggregation === 'pageviews') {
        aggHandler = series.pageViews;
    } else if (aggregation === 'visits') {
        aggHandler = series.visits;
    } else if (aggregation === 'bounces') {
        aggHandler = series.bounces;
    } else if (aggregation === 'organic') {
        aggHandler = series.organic;
    } else if (aggregation === 'earned') {
        aggHandler = series.earned;
    } else if (aggregation === 'lcp') {
        aggHandler = series.lcp;
    } else if (aggregation === 'cls') {
        aggHandler = series.cls;
    } else if (aggregation === 'inp') {
        aggHandler = series.inp;
    } else if (aggregation === 'ttfb') {
        aggHandler = series.ttfb;
    } else if (aggregation === 'engagement') {
        aggHandler = series.engagement;
    } else {
        throw new Error(`Unsupported aggregation: ${aggregation}`);
    }

    const d = new DataChunks();
    d.load(dataChunks);
    d.addSeries(aggregation, aggHandler);

    if (statistic === 'max') {
        return d.totals[aggregation].max;
    } else if (statistic === 'mean') {
        return d.totals[aggregation].mean;
    } else if (statistic === 'min') {
        return d.totals[aggregation].min;
    } else if (statistic === 'sum') {
        return d.totals[aggregation].sum;
    } else {
        throw new Error(`Unsupported statistic: ${statistic}`);
    }
}

async function run(url, domainkey, startdate, enddate) {
  try {

    const dataChunks = await getDataChunks(url, domainkey, startdate, enddate);
    const aggregation = 'pageviews';
    const statistic = 'mean';
    const stat = await getStatistic(dataChunks, 'cls', 'mean');
    console.log(`${aggregation} ${statistic}:`, stat);
  } catch (err) {
    console.error('Error fetching site ID:', err);
    console.error(err.stack);
  }
}

//run("www.hersheyland.com", '**', '2025/05/20', '2025/05/28');