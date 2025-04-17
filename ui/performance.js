/* eslint-disable prefer-object-spread, no-console */
(() => {
  /* display */
  const formatTime = (x) => (x !== 0 ? Math.round(x) : 0);
  const formatSize = (x) => (x !== 0 ? (Math.round(x / 1000)) : 0);
  const formatSizeKB = (x) => (x !== 0 ? x : 0);
  const formatTimeMS = (x) => `${formatTime(x)}ms`;

  const jsonSyntaxHighlight = (json) => {
    let output = json;
    if (typeof json !== 'string') {
      output = JSON.stringify(json, undefined, 2);
    }
    output = output.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return output.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
      let cls = 'number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'key';
        } else {
          cls = 'string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'boolean';
      } else if (/null/.test(match)) {
        cls = 'null';
      }
      return `<span class="${cls}">${match}</span>`;
    });
  };

  const applyFilter = (entryType, show, el) => {
    const rows = el.querySelectorAll(`.${entryType}`);
    rows.forEach((row) => {
      if (show) {
        row.classList.remove('hlx-hidden');
      } else {
        row.classList.add('hlx-hidden');
      }
    });
  };

  const generateGrid = (
    data,
    cols = ['index', 'start', 'end', 'url', 'entryType', 'size', 'totalSize', 'duration', 'preview', 'details'],
    defaultFilters = ['navigation', 'resource', 'lcp', 'tbt', 'inp', 'long-animation-frame', 'cls', 'paint', 'mark'],
    sortedBy = 'start',
  ) => {
    const grid = document.createElement('table');
    grid.classList.add('hlx-grid');

    const head = document.createElement('tr');
    head.classList.add('hlx-row');
    head.innerHTML = '';
    if (cols.includes('index')) head.innerHTML += '<th class="hlx-col-header hlx-xs hlx-right">#</th>';
    if (cols.includes('start')) head.innerHTML += `<th class="hlx-col-header hlx-s hlx-right">Start${sortedBy === 'start' ? '&darr;' : ''}</th>`;
    if (cols.includes('end')) head.innerHTML += `<th class="hlx-col-header hlx-s hlx-right">End${sortedBy === 'end' ? '&darr;' : ''}</th>`;
    if (cols.includes('url')) head.innerHTML += '<th class="hlx-col-header hlx-xl">URL</th>';
    if (cols.includes('entryType')) head.innerHTML += '<th class="hlx-col-header hlx-m hlx-center">Type</th>';
    if (cols.includes('size')) head.innerHTML += '<th class="hlx-col-header hlx-s hlx-right">Size KB</th>';
    if (cols.includes('totalSize')) head.innerHTML += '<th class="hlx-col-header hlx-s hlx-right">Total KB</th>';
    if (cols.includes('duration')) head.innerHTML += '<th class="hlx-col-header hlx-s hlx-right">Duration</th>';
    // if (cols.includes('preview')) head.innerHTML += '<th class="hlx-col-header hlx-m hlx-center">Info</th>';
    // if (cols.includes('details')) head.innerHTML += '<th class="hlx-col-header hlx-m">Details</th>';

    grid.appendChild(head);

    const current = new URL(window.location.href);
    const host = current.hostname;

    let index = 0;
    data.forEach((row) => {
      const {
        // eslint-disable-next-line max-len
        url, mimeType, size, totalSize, duration, /*details, */ start, end, name, before100kb, entryType, css,
      } = row;
      let urlDislay = url;
      if (url) {
        const u = new URL(url);
        if (u.hostname === host) {
          urlDislay = u.pathname;
        }
      } else {
        // use name instead of url
        urlDislay = name;
      }
      const classes = [];
      if (entryType === 'LCP') {
        classes.push('hlx-lcp');
      } else if (entryType === 'CLS') {
        classes.push('hlx-cls');
      } else if (entryType === 'TBT') {
        classes.push('hlx-tbt');
      } else if (entryType === 'INP') {
        classes.push('hlx-inp');
      } else if (entryType === 'long-animation-frame') {
        classes.push('hlx-laf');
      } else if (entryType === 'paint') {
        classes.push('hlx-paint');
      } else if (entryType === 'mark') {
        classes.push('hlx-mark');
      } else if (entryType === 'navigation') {
        classes.push('hlx-navigation');
      } else {
        classes.push('hlx-resource');
      }

      if (before100kb) {
        classes.push('hlx-before-100kb');
      }

      if (!defaultFilters.includes(entryType)) {
        classes.push('hlx-hidden');
      }

      if (css) {
        classes.push(css);
      }

      // const filteredPreview = details?.preview ? details?.preview.replace(/</gm, '&lt;').replace(/>/gm, '&gt;').replace(/"/gm, '&quot;') : null;
      // const preview = filteredPreview || details?.previewHTML || '';
      // const previewTitle = filteredPreview || '';

      const rowElement = document.createElement('tr');
      rowElement.className = `hlx-row ${classes.join(' ')}`;
      rowElement.innerHTML = '';
      if (cols.includes('index')) rowElement.innerHTML += `<td class="hlx-col hlx-xs hlx-right hlx-col-index">${index}</td>`;
      if (cols.includes('start')) rowElement.innerHTML += `<td class="hlx-col hlx-s hlx-right hlx-col-start">${formatTime(start)}</td>`;
      if (cols.includes('end')) rowElement.innerHTML += `<td class="hlx-col hlx-s hlx-right hlx-col-end">${formatTime(end)}</td>`;
      if (cols.includes('url')) rowElement.innerHTML += `<td class="hlx-col hlx-xl hlx-col-url">${url ? `<a href="${url}" target="_blank">${urlDislay}</a>` : `${urlDislay}`}</td>`;
      if (cols.includes('entryType')) rowElement.innerHTML += `<td class="hlx-col hlx-m hlx-center hlx-col-type"><span title="${name || ''}" class="hlx-badge">${entryType === 'mark' || entryType === 'paint' ? name : entryType}</span></td>`;
      if (cols.includes('size')) rowElement.innerHTML += `<td class="hlx-col hlx-s hlx-right hlx-col-size">${size !== undefined ? formatSizeKB(size) : ''}</td>`;
      if (cols.includes('totalSize')) rowElement.innerHTML += `<td class="hlx-col hlx-s hlx-right hlx-col-totalSize">${totalSize !== undefined ? formatSizeKB(totalSize) : ''}</td>`;
      if (cols.includes('duration')) rowElement.innerHTML += `<td class="hlx-col hlx-s hlx-right hlx-col-duration">${duration !== undefined ? formatTime(duration) : ''}</td>`;
      // if (cols.includes('preview')) rowElement.innerHTML += `<td class="hlx-col hlx-m hlx-center hlx-col-preview" title="${previewTitle}">${preview}</td>`;
      // if (cols.includes('details')) rowElement.innerHTML += `<td class="hlx-col hlx-m hlx-wrap hlx-col-details"><a href="#" data-details="${encodeURIComponent(JSON.stringify(details, null, 2))}">Details</a></td>`;

      grid.appendChild(rowElement);
      index += 1;
    });

    // grid.querySelectorAll('[data-details]').forEach((link) => {
    //   link.addEventListener('click', (e) => {
    //     e.preventDefault();
    //     if (e.target.innerHTML === 'Hide') {
    //       e.target.innerHTML = 'Details';
    //       e.target.parentElement.querySelector('pre').remove();
    //     } else {
    //       const details = JSON.parse(decodeURIComponent(e.target.getAttribute('data-details')));
    //       const pre = document.createElement('pre');
    //       pre.innerHTML = jsonSyntaxHighlight({ ...details });
    //       e.target.parentElement.appendChild(pre);
    //       e.target.innerHTML = 'Hide';
    //     }
    //   });
    // });

    return grid;
  };

  const generateFilters = (list = ['navigation', 'resource', 'lcp', 'tbt', 'inp', 'long-animation-frame', 'cls', 'paint', 'mark'], defaults = ['navigation', 'resource', 'lcp', 'tbt', 'inp', 'long-animation-frame', 'cls', 'paint', 'mark']) => {
    const filters = document.createElement('div');
    filters.classList.add('hlx-filters');
    filters.innerHTML = '';
    if (list.includes('navigation')) {
      filters.innerHTML += `<div class="hlx-navigation"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('navigation') ? 'checked' : ''}>Navigation</span></div>`;
    }
    if (list.includes('resource')) {
      filters.innerHTML += `<div class="hlx-resource"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('resource') ? 'checked' : ''}>Resource</span></div>`;
    }
    if (list.includes('lcp')) {
      filters.innerHTML += `<div class="hlx-lcp"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('lcp') ? 'checked' : ''}>LCP</span></div>`;
    }
    if (list.includes('tbt')) {
      filters.innerHTML += `<div class="hlx-tbt"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('tbt') ? 'checked' : ''}>TBT</span></div>`;
    }
    if (list.includes('inp')) {
      filters.innerHTML += `<div class="hlx-inp"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('inp') ? 'checked' : ''}>INP</span></div>`;
    }
    if (list.includes('long-animation-frame')) {
      filters.innerHTML += `<div class="hlx-laf"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('long-animation-frame') ? 'checked' : ''}>long-animation-frame</span></div>`;
    }
    if (list.includes('cls')) {
      filters.innerHTML += `<div class="hlx-cls"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('cls') ? 'checked' : ''}>CLS</span></div>`;
    }
    if (list.includes('paint')) {
      filters.innerHTML += `<div class="hlx-paint"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('paint') ? 'checked' : ''}>paint</span></div>`;
    }
    if (list.includes('mark')) {
      filters.innerHTML += `<div class="hlx-mark"><span class="hlx-badge"><input type="checkbox" ${defaults.includes('mark') ? 'checked' : ''}>mark</span></div>`;
    }

    filters.querySelectorAll('.hlx-filters input').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const type = checkbox.parentElement.parentElement.classList[0];
        applyFilter(type, checkbox.checked, document.querySelector('.hlx-grid'));
      });
    });

    return filters;
  };

  const VIEWS = {
    LCP: {
      filters: ['navigation', 'resource', 'lcp', 'mark', 'paint'],
      defaultFilters: ['navigation', 'resource', 'lcp', 'paint'],
      cols: ['index', 'start', 'end', 'url', 'entryType', 'size', 'totalSize', 'preview'],
      sortedBy: 'end',
      data: (d) => {
        const sorted = VIEWS.all.data(d, true);
        const lastIndex = sorted.findLastIndex((entry) => entry.entryType === 'LCP');
        if (lastIndex === -1) return sorted;
        return sorted.slice(0, lastIndex + 1);
      },
    },
    CLS: {
      filters: ['resource', 'CLS', 'mark', 'paint'],
      defaultFilters: ['resource', 'CLS'],
      cols: ['end', 'url', 'entryType', 'preview'],
      sortedBy: 'end',
      data: (data) => {
        data.sort((a, b) => a.end - b.end);
        let running = false;
        let count = 0;
        for (let i = data.length - 1; i >= 0; i -= 1) {
          const entry = data[i];
          if (entry.entryType === 'CLS') {
            // found CLS entry
            entry.css = 'hlx-cls-end';
            running = true;
            count = 0;
          } else if (running) {
            entry.css = 'hlx-cls-suspect';
            if (entry.entryType === 'resource') {
              count += 1;
              if (count === 3) {
                entry.css = 'hlx-cls-start';
                count = 0;
                running = false;
              }
            }
          }
        }
        return data;
      },
    },
    all: {
      filters: undefined,
      cols: undefined,
      defaultFilters: undefined,
      data: (data, sortByEndData = false) => {
        if (sortByEndData) {
          data.sort((a, b) => a.end - b.end);
        } else {
          data.sort((a, b) => a.start - b.start);
        }

        let totalSize = 0;

        return data.map((entry) => {
          const { size } = entry;
          if (size !== undefined) {
            totalSize += size;
            entry.totalSize = totalSize;
          }
          entry.before100kb = Math.round(totalSize) < 101;
          return entry;
        });
      },
    },
  };

  const display = (data) => {
    const component = document.createElement('div');

    const container = document.createElement('div');
    container.classList.add('hlx-container');
    container.id = 'hlx-report-dialog';
    component.append(container);

    const header = document.createElement('div');
    header.classList.add('hlx-header');
    header.innerHTML = `
      <h1>Performance report</h1>
    `;
    container.appendChild(header);

    document.body.prepend(component);

    const views = document.createElement('div');
    views.classList.add('hlx-views');
    views.innerHTML = `
      <label><input type="radio" name="view" value="LCP" checked>LCP Focus</label>
      <label><input type="radio" name="view" value="CLS" >CLS Focus</label>
      <label><input type="radio" name="view" value="all">View All</label>
    `;

    container.appendChild(views);

    const filters = generateFilters(VIEWS.LCP.filters, VIEWS.LCP.defaultFilters);
    container.appendChild(filters);

    // eslint-disable-next-line max-len
    const clone = (items) => items.map((item) => (Array.isArray(item) ? clone(item) : Object.assign({}, item)));

    const grid = generateGrid(
      VIEWS.LCP.data(clone(data)),
      VIEWS.LCP.cols,
      VIEWS.LCP.defaultFilters,
      VIEWS.LCP.sortedBy,
    );
    container.appendChild(grid);

    views.querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', (ev) => {
        const view = VIEWS[ev.target.value];

        container.querySelector('.hlx-filters').remove();
        container.querySelector('.hlx-grid').remove();

        const f = generateFilters(view.filters, view.defaultFilters);
        container.appendChild(f);

        const g = generateGrid(
          view.data(clone(data)),
          view.cols,
          view.defaultFilters,
          view.sortedBy,
        );
        container.appendChild(g);
      });
    });

    return container;
  };

  const getPerformanceReport = async () => {
    const usp = new URLSearchParams(window.location.search);
    const reportPath = usp.get('merge');

    if (!reportPath) {
      throw new Error('No "merge" parameter specified');
    }

    const res = await fetch(reportPath);
    const json = await res.json();

    return json.data.map((entry) => {
      const {
        start, end, name, url, duration, details, entryType, size, issues,
      } = entry;
      const ret = {};

      if (start) ret.start = Math.round(start); else ret.start = 0;
      if (end) ret.end = Math.round(end); else ret.end = ret.start;
      if (name) ret.name = name;
      if (url) ret.url = url;
      if (entryType) ret.entryType = entryType;
      if (duration !== undefined) ret.duration = Math.round(duration);
      if (size !== undefined) ret.size = size;
      // if (issues !== undefined) ret.issues = issues;

      // ret.details = details;
      return ret;
    });
  };

  const cleanup = () => {
    console.clear();

    const s = document.querySelector('hlx-perf-report');
    if (s) s.remove();
  };

  const main = async () => {
    cleanup();
    const data = await getPerformanceReport();
    display(data);
    data.sort((a, b) => a.start - b.start);
    window.PERFORMANCE_REPORT_DATA = {
      url: window.location.href,
      type: window.matchMedia("(max-width: 800px)").matches ? 'mobile' : 'desktop',
      data: data.map(({ start, end, name, url, duration, issues, entryType, size }) => {
        const ret = {
          start, end, entryType
        };
        if (name) ret.name = name;
        if (issues) ret.issues = issues;
        if (url) ret.url = url;
        if(duration) ret.duration = duration;
        if(size) ret.size = size;
        return ret;
      }),
    };
  };

  main();
})();
