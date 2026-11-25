(() => {
  const {
    connectPrices, coverage, exportCsv, fuels, initialRegion, inRegion,
    readDataset, regionOptions, unresolvedForDistrict,
  } = globalThis.fuelData;
  const { FuelMap } = globalThis;
  const localServer = /^https?:$/u.test(location.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

  const $ = id => document.getElementById(id);
  const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
  const inputs = {
    station: { file: $('station-file'), status: $('station-status'), count: $('station-count'), save: $('save-station'), label: '주유소' },
    price: { file: $('price-file'), status: $('price-status'), count: $('price-count'), save: $('save-price'), label: '판매가격' },
  };
  const province = $('province'), district = $('district');
  const list = $('station-list'), search = $('station-search'), detail = $('price-detail');
  const mapView = $('map-view');
  const map = new FuelMap($('boundaries'), station => selectStation(station, true));
  const state = { mode: '', catalog: {}, results: {}, resultsVersion: 0, page: 0, station: null };
  const pageSize = 15;
  let catalogRequest, boundaryRequest;

  async function localJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function bundledData(path, key) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = path;
      script.onload = () => {
        const value = globalThis[key];
        delete globalThis[key];
        script.remove();
        if (value === undefined) reject(new Error(`${path} is empty`));
        else resolve(value);
      };
      script.onerror = () => { script.remove(); reject(new Error(`${path} could not be loaded`)); };
      document.head.append(script);
    });
  }

  async function bundledBoundaries() {
    const encoded = await bundledData('./offline-boundaries.js', 'fuelBoundariesGzip');
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
    const json = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(json).json();
  }

  function getCatalog() {
    catalogRequest ??= (localServer ? localJson('/regions.json') : bundledData('./offline-regions.js', 'fuelRegions')).then(catalog => {
      state.catalog = catalog;
      return catalog;
    }).catch(() => {
      catalogRequest = undefined;
      throw new Error('행정구역 목록을 읽을 수 없습니다. 실행 안내에 있는 파일 위치를 확인한 뒤 CSV를 다시 선택하세요.');
    });
    return catalogRequest;
  }

  function getBoundaries() {
    boundaryRequest ??= (localServer ? localJson('/boundaries.geojson') : bundledBoundaries()).then(geo => {
      const grouped = new Map();
      for (const feature of geo.features) {
        const { sidonm, sggnm } = feature.properties;
        if (!grouped.has(sidonm)) grouped.set(sidonm, []);
        grouped.get(sidonm).push({ province: sidonm, district: sggnm.replace(/\s+/gu, ''), ...feature });
      }
      return grouped;
    }).catch(error => { boundaryRequest = undefined; throw error; });
    return boundaryRequest;
  }

  function message(element, value, error = false) {
    element.textContent = value;
    element.classList.toggle('error', error);
  }

  function updateRoute() {
    const route = location.hash.slice(1);
    const next = route === 'extract' || route === 'map' ? route : 'home';
    if (state.mode === next) return;
    state.mode = next;
    $('home').hidden = next !== 'home';
    $('workspace').hidden = next === 'home';
    $('extract-results').hidden = next !== 'extract';
    $('map-results').hidden = next !== 'map';
    if (next === 'home') {
      state.resultsVersion++;
      if (location.hash) $('home-title').focus({ preventScroll: true });
    } else {
      $('workspace-title').textContent = next === 'extract' ? '지역 자료 추출' : '지도·가격 조회';
      $('workspace-description').textContent = next === 'extract'
        ? '두 CSV 파일에서 선택한 지역의 자료를 각각 저장합니다.'
        : '전국 원본 또는 지역별 CSV를 불러와 주유소 위치와 판매가격을 확인합니다.';
      $('region-title').textContent = next === 'extract' ? '추출 지역' : '조회 지역';
      $('workspace-title').focus({ preventScroll: true });
      updateOptions(next === 'map' && !province.value);
    }
    window.scrollTo(0, 0);
  }

  function setOptions(select, placeholder, values, selected = '') {
    select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));
    select.value = values.includes(selected) ? selected : '';
  }

  function updateOptions(auto = false) {
    const stations = inputs.station.dataset, prices = inputs.price.dataset;
    const ready = Boolean(stations && prices);
    state.regions = regionOptions(state.catalog, stations, prices);
    const [selectedProvince, selectedDistrict] = (ready && auto && initialRegion(stations, prices)) || [province.value, district.value];
    setOptions(province, '시·도 선택', [...state.regions.keys()], selectedProvince);
    setOptions(district, '전체', state.regions.get(province.value) ?? [], selectedDistrict);
    province.disabled = !ready;
    district.disabled = !ready || !province.value;
    renderResults();
  }

  async function readFile(kind) {
    const input = inputs[kind];
    const file = input.file.files[0];
    if (!file) return;
    const job = Symbol();
    input.job = job;
    input.dataset = null;
    message(input.status, `${file.name} 읽는 중…`);
    updateOptions();
    try {
      const [bytes, catalog] = await Promise.all([file.arrayBuffer(), getCatalog()]);
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (input.job !== job) return;
      const dataset = readDataset(bytes, kind, catalog);
      input.dataset = dataset;
      const excluded = [...dataset.issues.values()].reduce((sum, count) => sum + count, 0);
      const reasons = [...dataset.issues].map(([reason, count]) => `${reason} ${format.format(count)}건`);
      const summary = `${file.name} · 유효 ${format.format(dataset.rows.length)}건 · 제외 ${format.format(excluded)}건`;
      message(input.status, reasons.length ? `${summary} (${reasons.join(', ')})` : summary);
    } catch (error) {
      if (input.job !== job) return;
      input.file.value = '';
      message(input.status, `${file.name} · ${error.message}`, true);
    }
    updateOptions(state.mode === 'map');
  }

  function renderResults() {
    const version = ++state.resultsVersion;
    const stations = inputs.station.dataset, prices = inputs.price.dataset;
    const area = [province.value, district.value];
    const ready = Boolean(stations && prices && area[0]);
    const selectedStations = ready ? stations.rows.filter(row => inRegion(row, ...area)) : [];
    const selectedPrices = ready ? prices.rows.filter(row => inRegion(row, ...area)) : [];
    state.results = { station: selectedStations, price: selectedPrices };
    const regionStatus = [];
    if (!stations || !prices) regionStatus.push('두 CSV를 불러오면 지역을 선택할 수 있습니다.');
    else if (!area[0]) regionStatus.push('시·도를 선택하세요. 시·군·구는 전체로 둘 수 있습니다.');
    if (stations && prices && state.mode === 'map') {
      const stationAreas = coverage(stations), priceAreas = coverage(prices);
      if (stationAreas.size !== priceAreas.size || [...stationAreas].some(key => !priceAreas.has(key))) {
        regionStatus.push('두 파일에 포함된 지역 범위가 다릅니다. 선택 지역에서 확인할 수 있는 자료를 표시합니다.');
      }
    }
    if (ready && area[1]) {
      const counts = [unresolvedForDistrict(stations.rows, ...area), unresolvedForDistrict(prices.rows, ...area)];
      if (counts.some(Boolean)) regionStatus.push(`시 단위 자료 중 소속 구를 확인하지 못한 주유소 ${format.format(counts[0])}건, 판매가격 ${format.format(counts[1])}건을 제외했습니다.`);
    }
    message($('region-status'), regionStatus.join(' '));
    message($('export-status'), '');
    for (const [kind, input] of Object.entries(inputs)) {
      input.save.disabled = !ready;
      input.count.textContent = ready ? `${format.format(state.results[kind].length)}건` : '—';
    }
    if (state.mode === 'map') renderMap(version, ready, area, selectedStations, selectedPrices);
  }

  async function renderMap(version, ready, area, stations, prices) {
    mapView.hidden = true;
    search.disabled = true;
    search.value = '';
    state.page = 0;
    state.station = null;
    state.mapStations = [];
    state.connections = null;
    updateList();
    updatePrice();
    const status = $('map-status');
    if (!ready) {
      message(status, 'CSV 파일을 불러오고 지역을 선택하면 지도가 표시됩니다.');
      return;
    }
    message(status, '행정동 경계와 판매가격을 불러오는 중…');
    let features = [], boundaryError = false;
    try {
      const boundaries = await getBoundaries();
      features = (boundaries.get(area[0]) ?? []).filter(feature => inRegion(feature, ...area));
    } catch {
      boundaryError = true;
    }
    if (version !== state.resultsVersion) return;
    state.mapStations = [...stations].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    state.connections = connectPrices(stations, prices);
    const points = stations.filter(station => station.point).length;
    const marks = [`지도 주유소 ${format.format(points)}개`, `연결되지 않은 판매가격 ${format.format(state.connections.unmatched)}건`];
    if (stations.length > points) marks.push(`지도에 표시할 수 없는 좌표 ${format.format(stations.length - points)}건`);
    if (!features.length) marks.push(boundaryError ? 'GeoJSON 경계를 읽을 수 없습니다.' : '선택 지역에 해당하는 GeoJSON 경계가 없습니다.');
    message(status, marks.join(' · '), boundaryError);
    mapView.hidden = !features.length && !points;
    map.setData(features, stations);
    search.disabled = !stations.length;
    updateList();
  }

  function updateList() {
    const term = search.value.trim().normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    const items = (state.mapStations ?? []).filter(station => !term || [station.name, ...station.addresses]
      .some(value => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase().includes(term)));
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    const visible = items.slice(state.page * pageSize, (state.page + 1) * pageSize);
    list.replaceChildren(...visible.map(station => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.station = String(state.mapStations.indexOf(station));
      button.setAttribute('aria-pressed', String(state.station === station));
      const name = document.createElement('strong'), address = document.createElement('span');
      name.textContent = station.name;
      address.textContent = station.addresses.find(Boolean) || '주소 미제공';
      button.append(name, address);
      item.append(button);
      return item;
    }));
    message($('list-status'), state.connections ? `주유소 ${format.format(items.length)}개${term ? ' 검색됨' : ''}` : '지역 자료를 기다리는 중입니다.');
    $('pagination').hidden = pages === 1;
    $('list-page').textContent = `${state.page + 1} / ${pages}`;
    $('previous-page').disabled = state.page === 0;
    $('next-page').disabled = state.page >= pages - 1;
  }

  function selectStation(station, fromMap = false) {
    state.station = station;
    map.select(station);
    if (fromMap) {
      search.value = '';
      state.page = Math.floor(state.mapStations.indexOf(station) / pageSize);
      updateList();
    } else {
      for (const button of list.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(state.mapStations[Number(button.dataset.station)] === station));
      }
    }
    updatePrice();
    if (fromMap) $('detail-title').scrollIntoView({ block: 'nearest' });
  }

  function addText(parent, tag, text, className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  function updatePrice() {
    detail.replaceChildren();
    const station = state.station;
    if (!station) {
      addText(detail, 'p', '지도나 목록에서 주유소를 선택하세요.', 'detail-empty');
      return;
    }
    addText(detail, 'h3', station.name);
    addText(detail, 'p', [station.addresses.find(Boolean) || '주소 미제공', station.brand || '상표 미제공'].join(' · '), 'detail-meta');
    const connection = state.connections?.byStation.get(station);
    if (!connection) {
      addText(detail, 'p', '연결된 판매가격 없음', 'detail-empty');
      return;
    }
    if (connection.conflictingDates.size) addText(detail, 'p', '같은 날짜에 서로 다른 가격 기록이 있습니다.', 'detail-meta');
    const wrapper = addText(detail, 'div', '', 'table-scroll');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', '날짜별 판매가격 표');
    const table = addText(wrapper, 'table', '');
    addText(table, 'caption', '단위 원/L');
    const header = table.createTHead().insertRow();
    for (const name of ['날짜', ...fuels]) addText(header, 'th', name).scope = 'col';
    const body = table.createTBody();
    for (const record of connection.rows) {
      const row = body.insertRow();
      const date = `${record.date.slice(0, 4)}-${record.date.slice(4, 6)}-${record.date.slice(6)}`;
      addText(row, 'th', date).scope = 'row';
      for (const value of record.prices) addText(row, 'td', Number(value) ? format.format(Number(value)) : '—');
    }
  }

  function saveFile(kind) {
    const input = inputs[kind];
    if (input.save.disabled) return;
    const fileName = `${[province.value, district.value, input.label].filter(Boolean).join('_').replace(/[<>:"/\\|?*]/gu, '-')}.csv`;
    const csv = exportCsv(input.dataset, state.results[kind]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.download = fileName;
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    message($('export-status'), `${fileName} 다운로드를 요청했습니다.`);
  }

  window.addEventListener('hashchange', updateRoute);
  for (const [kind, input] of Object.entries(inputs)) {
    input.file.addEventListener('change', () => readFile(kind));
    input.save.addEventListener('click', () => saveFile(kind));
  }
  province.addEventListener('change', () => {
    setOptions(district, '전체', state.regions.get(province.value) ?? []);
    district.disabled = !province.value;
    renderResults();
  });
  district.addEventListener('change', renderResults);
  search.addEventListener('input', () => { state.page = 0; updateList(); });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-station]');
    if (button) selectStation(state.mapStations[Number(button.dataset.station)]);
  });
  $('previous-page').addEventListener('click', () => { state.page--; updateList(); });
  $('next-page').addEventListener('click', () => { state.page++; updateList(); });
  $('zoom-in').addEventListener('click', () => map.magnify(1.4));
  $('zoom-out').addEventListener('click', () => map.magnify(1 / 1.4));
  $('map-reset').addEventListener('click', () => map.reset());
  updateRoute();
})();
