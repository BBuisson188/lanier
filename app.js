const POOL = 1071;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = 'America/New_York';
const API = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/';
const RANGE_OPTIONS = {
  today: { days: 1, intervals: ['hourly'] },
  '7d': { days: 7, intervals: ['hourly', 'daily'] },
  '30d': { days: 30, intervals: ['daily', 'weekly'] },
  '90d': { days: 90, intervals: ['daily', 'weekly', 'monthly'] },
  '6m': { months: 6, intervals: ['weekly', 'daily', 'monthly'] },
  '1y': { months: 12, intervals: ['weekly', 'daily', 'monthly'] },
  '10y': { months: 120, intervals: ['monthly', 'weekly', 'yearly'] },
};
const get = id => document.getElementById(id);
const range = get('range');
const interval = get('interval');
const canvas = get('chart');
const context = canvas.getContext('2d');
const picker = get('point-picker');
const tooltip = get('tooltip');
const dateParts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const measuredTime = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const elevationFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dates = {
  time: new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric' }),
  hour: new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', timeZoneName: 'short' }),
  day: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
  full: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }),
  month: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }),
  year: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' }),
};
const cache = new Map();
let historyRequest;
let readingRequest;
let chart;
let chartLayout;
let highlighted = -1;
let preferredInterval = 'auto';

function easternDate(timestamp) {
  const parts = Object.fromEntries(dateParts.formatToParts(timestamp).map(part => [part.type, part.value]));
  return { day: Date.UTC(+parts.year, +parts.month - 1, +parts.day), hour: +parts.hour };
}

function eastMidnight(day) {
  const candidate = day + 5 * HOUR;
  return candidate - easternDate(candidate).hour * HOUR;
}

function firstDay(today, config) {
  if (config.days) return today - (config.days - 1) * DAY;
  const date = new Date(today);
  const dayNumber = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - config.months);
  const endOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  date.setUTCDate(Math.min(dayNumber, endOfMonth.getUTCDate()));
  return +date;
}

async function fetchSeries(collection, query, signal) {
  const url = new URL(`${collection}/items`, API);
  url.search = new URLSearchParams({
    f: 'json', monitoring_location_id: 'USGS-02334400', parameter_code: '00062', skipGeometry: 'true', ...query,
  });
  const observations = new Map();
  let next = url.href;
  while (next) {
    const response = await fetch(next, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`USGS returned ${response.status}`);
    const page = await response.json();
    for (const { properties: row } of page.features) {
      const time = Date.parse(row.time);
      const value = Number(row.value);
      if (row.unit_of_measure === 'ft' && Number.isFinite(time) && Number.isFinite(value) && value > 0) {
        observations.set(time, { time, value });
      }
    }
    const link = page.links?.find(link => link.rel === 'next');
    next = link ? new URL(link.href, next).href : null;
  }
  return [...observations.values()].sort((a, b) => a.time - b.time);
}

function showReadingStatus(message, retry = false) {
  const status = get('reading-status');
  status.textContent = message;
  status.hidden = !message;
  get('retry-reading').hidden = !retry;
}

async function loadReading() {
  readingRequest?.abort();
  readingRequest = new AbortController();
  const { signal } = readingRequest;
  showReadingStatus('Checking the latest USGS reading…');
  try {
    const observations = await fetchSeries('latest-continuous', { statistic_id: '00011' }, signal);
    if (signal.aborted) return;
    const reading = observations[observations.length - 1];
    if (!reading) throw new Error('Empty reading');
    const delta = Math.round((reading.value - POOL) * 100) / 100;
    const magnitude = Math.abs(delta);
    const direction = get('direction');
    direction.textContent = delta < 0 ? '↓' : '↑';
    direction.hidden = delta === 0;
    get('difference').textContent = magnitude.toFixed(magnitude > 0 && magnitude < 0.1 ? 2 : 1);
    get('comparison').textContent = `${delta < 0 ? 'Below' : delta > 0 ? 'Above' : 'At'} 1,071 ft (summer full pool)`;
    get('elevation').textContent = `${elevationFormat.format(reading.value)} ft`;
    get('measured').textContent = measuredTime.format(reading.time);
    showReadingStatus(Date.now() - reading.time > 3 * HOUR ? 'Latest USGS reading is more than 3 hours old.' : '');
  } catch (error) {
    if (!signal.aborted) showReadingStatus('Unable to check the latest USGS reading.', true);
  }
}

function updateIntervals() {
  const choices = ['auto', ...RANGE_OPTIONS[range.value].intervals];
  interval.replaceChildren(...choices.map(choice => new Option(choice[0].toUpperCase() + choice.slice(1), choice)));
  interval.value = choices.includes(preferredInterval) ? preferredInterval : 'auto';
}

function bucketStart(time, step) {
  if (step === 'hourly') return Math.floor(time / HOUR) * HOUR;
  if (step === 'daily') return time;
  const date = new Date(time);
  if (step === 'weekly') return time - (date.getUTCDay() + 6) % 7 * DAY;
  return Date.UTC(date.getUTCFullYear(), step === 'yearly' ? 0 : date.getUTCMonth(), 1);
}

function nextBucket(time, step) {
  if (step === 'hourly') return time + HOUR;
  if (step === 'daily') return time + DAY;
  if (step === 'weekly') return time + 7 * DAY;
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + (step === 'yearly' ? 12 : 1), 1);
}

function averageBuckets(observations, step) {
  const buckets = new Map();
  for (const { time, value } of observations) {
    const start = bucketStart(time, step);
    const bucket = buckets.get(start) ?? { time: start, sum: 0, count: 0 };
    bucket.sum += value;
    bucket.count++;
    buckets.set(start, bucket);
  }
  return [...buckets.values()].map(({ time, sum, count }) => ({ time, value: sum / count }));
}

function showChartStatus(message, retry = false) {
  get('chart-message').hidden = !message;
  get('chart-status').textContent = message;
  get('retry-history').hidden = !retry;
}

async function loadHistory() {
  historyRequest?.abort();
  historyRequest = new AbortController();
  const { signal } = historyRequest;
  const config = RANGE_OPTIONS[range.value];
  const step = interval.value === 'auto' ? config.intervals[0] : interval.value;
  const hourly = step === 'hourly';
  const now = Date.now();
  const today = easternDate(now).day;
  const start = firstDay(today, config);
  const from = hourly ? eastMidnight(start) : start;
  const to = hourly ? now : today;
  const dateOnly = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  const collection = hourly ? 'continuous' : 'daily';
  const cacheKey = `${collection}:${start}:${today}`;

  get('series-label').textContent = `${step[0].toUpperCase()}${step.slice(1)} average`;
  chart = null;
  highlighted = -1;
  picker.hidden = true;
  showChartStatus('Loading elevation history…');
  drawChart();
  try {
    let observations = cache.get(cacheKey);
    if (!observations) {
      observations = await fetchSeries(collection, {
        statistic_id: hourly ? '00011' : '00003',
        datetime: hourly ? `${new Date(from).toISOString()}/${new Date(to).toISOString()}` : `${dateOnly(from)}/${dateOnly(to)}`,
        limit: hourly ? '1000' : '5000',
      }, signal);
      if (signal.aborted) return;
      if (observations.length) cache.set(cacheKey, observations);
    }

    const points = averageBuckets(observations, step);
    if (!points.length) {
      showChartStatus('USGS has no readings for this range yet.', true);
      return;
    }
    chart = { points, step, from: bucketStart(from, step), to: Math.max(to, from + (hourly ? HOUR : DAY)) };
    picker.max = points.length - 1;
    picker.value = points.length - 1;
    picker.hidden = false;
    updatePicker(points.length - 1);
    showChartStatus('');
    drawChart();
  } catch (error) {
    if (!signal.aborted) showChartStatus('Unable to load USGS elevation history.', true);
  }
}

function axisDate(time, step, span) {
  if (step === 'hourly') return (span < DAY ? dates.time : dates.day).format(time + (span < DAY ? 0 : easternDate(time).day - time));
  if (step === 'yearly' || span > 2 * 365 * DAY) return dates.year.format(time);
  if (step === 'monthly' || span > 180 * DAY) return dates.month.format(time);
  return dates.day.format(time);
}

function drawChart() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpi = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpi);
  canvas.height = Math.round(height * dpi);
  context.setTransform(dpi, 0, 0, dpi, 0, 0);
  tooltip.hidden = true;
  chartLayout = null;
  if (!chart) return;

  const { points, from, to, step } = chart;
  const bounds = { left: 55, right: width - 10, top: 16, bottom: height - 35 };
  const values = points.map(point => point.value);
  const minimum = Math.min(POOL, ...values);
  const maximum = Math.max(POOL, ...values);
  const spacing = [0.5, 1, 2, 5, 10, 20, 50].find(size => size * 5 >= maximum - minimum) ?? 100;
  const low = Math.floor((minimum - spacing * .2) / spacing) * spacing;
  const high = Math.ceil((maximum + spacing * .2) / spacing) * spacing;
  const x = time => bounds.left + (time - from) / (to - from) * (bounds.right - bounds.left);
  const y = level => bounds.bottom - (level - low) / (high - low) * (bounds.bottom - bounds.top);
  chartLayout = { x };

  context.font = '13px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  context.fillStyle = '#4c6268';
  context.strokeStyle = '#e1e8e3';
  context.lineWidth = 1;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let level = low; level <= high; level += spacing) {
    context.beginPath();
    context.moveTo(bounds.left, y(level));
    context.lineTo(bounds.right, y(level));
    context.stroke();
    context.fillText(level.toLocaleString('en-US'), bounds.left - 8, y(level));
  }

  const tickCount = width < 440 ? 3 : width < 700 ? 4 : 6;
  let lastLabel;
  for (let tick = 0; tick < tickCount; tick++) {
    const time = from + (to - from) * tick / (tickCount - 1);
    const label = axisDate(time, step, to - from);
    if (label === lastLabel) continue;
    context.textAlign = tick === 0 ? 'left' : tick === tickCount - 1 ? 'right' : 'center';
    context.fillText(label, x(time), bounds.bottom + 20);
    lastLabel = label;
  }

  context.strokeStyle = '#677b7d';
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(bounds.left, y(POOL));
  context.lineTo(bounds.right, y(POOL));
  context.stroke();
  context.setLineDash([]);

  const gradient = context.createLinearGradient(0, bounds.top, 0, bounds.bottom);
  gradient.addColorStop(0, '#17766e29');
  gradient.addColorStop(1, '#17766e03');
  const segments = [];
  for (const point of points) {
    const segment = segments[segments.length - 1];
    if (!segment || point.time > nextBucket(segment[segment.length - 1].time, step)) segments.push([point]);
    else segment.push(point);
  }

  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.strokeStyle = '#17766e';
  for (const segment of segments) {
    const first = segment[0];
    const last = segment[segment.length - 1];
    context.beginPath();
    if (segment.length === 1) {
      context.fillStyle = '#17766e';
      context.arc(x(first.time), y(first.value), 2.5, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.moveTo(x(first.time), y(first.value));
    for (const point of segment.slice(1)) context.lineTo(x(point.time), y(point.value));
    context.stroke();
    context.lineTo(x(last.time), bounds.bottom);
    context.lineTo(x(first.time), bounds.bottom);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
  }

  const point = points[highlighted];
  if (point) {
    context.strokeStyle = '#677b7d';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x(point.time), bounds.top);
    context.lineTo(x(point.time), bounds.bottom);
    context.stroke();
    context.beginPath();
    context.fillStyle = '#17766e';
    context.arc(x(point.time), y(point.value), 4, 0, Math.PI * 2);
    context.fill();
    tooltip.textContent = pointLabel(point, step);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(0, Math.min(width - tooltip.offsetWidth, x(point.time) - tooltip.offsetWidth / 2))}px`;
  }
}

function pointLabel(point, step) {
  const format = { hourly: dates.hour, daily: dates.full, weekly: dates.full, monthly: dates.month, yearly: dates.year }[step];
  const prefix = step === 'weekly' ? 'Week of ' : '';
  return `${prefix}${format.format(point.time)} · ${elevationFormat.format(point.value)} ft`;
}

function updatePicker(index) {
  picker.value = index;
  picker.setAttribute('aria-valuetext', pointLabel(chart.points[index], chart.step));
}

function highlight(index) {
  if (index === highlighted) return;
  highlighted = index;
  if (index >= 0) updatePicker(index);
  drawChart();
}

function inspectPointer(event) {
  if (!chartLayout || !chart) return;
  const pixel = event.clientX - canvas.getBoundingClientRect().left;
  let closest = 0;
  let smallestDistance = Infinity;
  chart.points.forEach((point, index) => {
    const distance = Math.abs(chartLayout.x(point.time) - pixel);
    if (distance < smallestDistance) {
      closest = index;
      smallestDistance = distance;
    }
  });
  highlight(closest);
}

range.addEventListener('change', () => { updateIntervals(); loadHistory(); });
interval.addEventListener('change', () => { preferredInterval = interval.value; loadHistory(); });
get('retry-reading').addEventListener('click', loadReading);
get('retry-history').addEventListener('click', loadHistory);
canvas.addEventListener('pointerdown', inspectPointer);
canvas.addEventListener('pointermove', event => {
  if (event.pointerType === 'mouse' || event.buttons) inspectPointer(event);
});
canvas.addEventListener('pointerleave', event => {
  if (event.pointerType === 'mouse' && document.activeElement !== picker) highlight(-1);
});
picker.addEventListener('input', () => highlight(Number(picker.value)));
picker.addEventListener('focus', () => highlight(Number(picker.value)));
picker.addEventListener('blur', () => highlight(-1));
new ResizeObserver(drawChart).observe(get('plot'));
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    cache.clear();
    loadReading();
    loadHistory();
  }
});

updateIntervals();
loadReading();
loadHistory();
