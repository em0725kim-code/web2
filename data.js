(() => {
  const provinces = [
    ['서울특별시', '서울', '서울시'], ['부산광역시', '부산', '부산시'],
    ['대구광역시', '대구', '대구시'], ['인천광역시', '인천', '인천시'],
    ['대전광역시', '대전', '대전시'], ['울산광역시', '울산', '울산시'],
    ['세종특별자치시', '세종', '세종시'], ['경기도', '경기'],
    ['강원특별자치도', '강원', '강원도'], ['충청북도', '충북'], ['충청남도', '충남'],
    ['전북특별자치도', '전북', '전라북도'],
    ['전남광주통합특별시', '전남광주', '전라남도', '전남', '광주광역시', '광주'],
    ['경상북도', '경북'], ['경상남도', '경남'], ['제주특별자치도', '제주도', '제주'],
  ];
  const aliases = new Map(provinces.flatMap(group => group.map(alias => [alias, group[0]])));
  const provincePrefixes = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const labelOrder = (a, b) => a.localeCompare(b, 'ko');
  const compact = value => (value ?? '').normalize('NFKC').replace(/\s+/gu, '');
  const fuels = ['고급휘발유', '휘발유', '경유', '실내등유'];
  const required = {
    station: ['주유소명', '시도명', '시군구명', '소재지도로명주소', '소재지지번주소', '위도', '경도'],
    price: ['번호', '지역', '상호', '주소', '기간', ...fuels],
  };

  function parseCsv(text) {
    const records = [];
    let cells = [], value = '', state = 'start', invalid = false;
    function finishCell() {
      cells.push(value);
      value = '';
      state = 'start';
    }
    function finishRecord() {
      finishCell();
      if (invalid || cells.length > 1 || cells[0].trim()) records.push({ cells, invalid });
      cells = [];
      invalid = false;
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (state === 'quoted') {
        if (char === '"' && text[i + 1] === '"') {
          value += '"';
          i++;
        } else if (char === '"') {
          state = 'closed';
        } else {
          value += char;
        }
      } else if (char === ',') {
        finishCell();
      } else if (char === '\r' || char === '\n') {
        finishRecord();
        if (char === '\r' && text[i + 1] === '\n') i++;
      } else if (char === '"' && state === 'start') {
        state = 'quoted';
      } else {
        if (state === 'closed' || char === '"') invalid = true;
        value += char;
        state = 'plain';
      }
    }
    if (state === 'quoted') invalid = true;
    finishRecord();
    return records;
  }

  function cityParent(district) {
    return /^(\S+?시)\S+구$/u.exec(district)?.[1] ?? district;
  }

  function createCatalog(features) {
    const groups = new Map();
    for (const { properties } of features) {
      const province = properties.sidonm;
      const district = compact(properties.sggnm);
      if (!province || !district) continue;
      if (!groups.has(province)) groups.set(province, new Set());
      const names = groups.get(province);
      names.add(district);
      names.add(cityParent(district));
    }
    return Object.fromEntries([...groups].map(([name, districts]) => [name, [...districts].sort(labelOrder)]));
  }

  function regionOptions(catalog, ...datasets) {
    const result = new Map(Object.entries(catalog).map(([key, names]) => [key, new Set(names)]));
    for (const dataset of datasets) {
      for (const { province, district } of dataset?.rows ?? []) {
        if (!result.has(province)) result.set(province, new Set());
        if (district) {
          result.get(province).add(district);
          result.get(province).add(cityParent(district));
        }
      }
    }
    return new Map([...result].sort(([a], [b]) => labelOrder(a, b))
      .map(([province, districts]) => [province, [...districts].sort(labelOrder)]));
  }

  function normalizeRegion(rawProvince, rawDistrict, addresses, catalog) {
    const province = aliases.get(compact(rawProvince)) ?? compact(rawProvince);
    let district = compact(rawDistrict);
    if (district === '없음' || district === '해당없음' || district === '-') district = '';
    if (province === '세종특별자치시' && (!district || aliases.get(district) === province)) district = '세종시';
    if (district && district === cityParent(district) && district.endsWith('시')) {
      const children = (catalog[province] ?? []).filter(name => name !== district && cityParent(name) === district);
      const matches = new Set();
      for (const address of addresses) {
        const local = stripProvince(address, province);
        for (const child of children) {
          if (local.startsWith(child)) matches.add(child);
        }
      }
      if (matches.size === 1) district = matches.values().next().value;
    }
    return { province, district };
  }

  function stripProvince(address, province) {
    const value = compact(address);
    const prefix = provincePrefixes.find(candidate => aliases.get(candidate) === province && value.startsWith(candidate));
    return prefix ? value.slice(prefix.length) : value;
  }

  function decode(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
    }
  }

  function validDate(value) {
    if (!/^\d{8}$/u.test(value)) return false;
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === iso;
  }

  function readDataset(bytes, kind, catalog = {}) {
    let records;
    try {
      records = parseCsv(decode(bytes));
    } catch {
      throw new Error('파일의 문자 인코딩을 읽을 수 없습니다. CP949 또는 UTF-8 CSV를 선택하세요.');
    }
    const header = records.shift();
    if (!header || header.invalid) throw new Error('CSV 헤더를 읽을 수 없습니다. 첫 행에 열 이름이 있는 파일을 선택하세요.');
    const columns = new Map(header.cells.map((value, index) => [value.trim(), index]));
    const missing = required[kind].filter(column => !columns.has(column));
    if (missing.length) {
      const other = kind === 'station' ? 'price' : 'station';
      if (required[other].every(column => columns.has(column))) {
        throw new Error(`이 파일은 ${other === 'price' ? '판매가격' : '주유소 표준'} CSV입니다. 해당 입력에 선택하세요.`);
      }
      throw new Error(`필수 열이 없습니다 (${missing.join(', ')}). 원본 CSV의 열 이름을 확인하세요.`);
    }
    if (columns.size !== header.cells.length) throw new Error('CSV 헤더에 같은 이름의 열이 여러 개 있습니다.');
    const issues = new Map(), rows = [];
    const exclude = reason => issues.set(reason, (issues.get(reason) ?? 0) + 1);
    let note = null;
    for (const [index, { cells, invalid }] of records.entries()) {
      if (kind === 'price' && index === 0 && !invalid && cells.length === 1 && /^\s*기준\s*[:：]/u.test(cells[0])) {
        note = cells;
        continue;
      }
      if (invalid || cells.length !== header.cells.length) {
        exclude('CSV 형식 또는 열 개수 오류');
        continue;
      }
      const get = column => (cells[columns.get(column)] ?? '').trim();
      const station = kind === 'station';
      const name = get(station ? '주유소명' : '상호');
      const addresses = station ? [get('소재지도로명주소'), get('소재지지번주소')] : [get('주소')];
      const [rawProvince, rawDistrict] = station
        ? [get('시도명'), get('시군구명')]
        : /^([^\s]+)\s*(.*)$/u.exec(get('지역'))?.slice(1) ?? ['', ''];
      const region = normalizeRegion(rawProvince, rawDistrict, addresses, catalog);
      if (!region.province || !name) {
        exclude('지역 또는 주유소 이름 누락');
        continue;
      }
      if (station) {
        const lat = get('위도'), lon = get('경도');
        const point = lat && lon && Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(+lat) <= 90 && Math.abs(+lon) <= 180 && (+lon !== 0 || +lat !== 0)
          ? [+lon, +lat] : null;
        rows.push({ ...region, cells, name, addresses, point, brand: get('상표구분명') });
      } else {
        const id = get('번호'), date = get('기간');
        const prices = fuels.map(get);
        if (!id || !validDate(date) || prices.some(price => price && !/^\d+(?:\.\d+)?$/u.test(price))) {
          exclude('주유소 번호·날짜·가격 값 오류');
          continue;
        }
        rows.push({ ...region, cells, name, addresses, id, date, prices });
      }
    }
    return { header: header.cells, note, rows, issues };
  }

  function inRegion(row, province, district = '') {
    return row.province === province && (!district || row.district === district || cityParent(row.district) === district);
  }

  function unresolvedForDistrict(rows, province, district) {
    const parent = cityParent(district);
    return district !== parent ? rows.filter(row => row.province === province && row.district === parent).length : 0;
  }

  function coverage(dataset) {
    const areas = new Set();
    for (const row of dataset.rows) areas.add(`${row.province}\t${row.district}`);
    return areas;
  }

  function initialRegion(stations, prices) {
    const areas = [...new Set([...coverage(stations), ...coverage(prices)])].map(key => key.split('\t'));
    if (!areas.length || areas.some(([province]) => province !== areas[0][0])) return null;
    const [province, district] = areas[0];
    if (areas.every(([, name]) => name === district)) return [province, district];
    const parent = cityParent(district);
    return [province, parent && areas.every(([, name]) => cityParent(name) === parent) ? parent : ''];
  }

  function exportCsv(dataset, rows) {
    const quote = value => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    const source = [dataset.header];
    if (dataset.note) source.push(dataset.note);
    source.push(...rows.map(row => row.cells));
    return `\uFEFF${source.map(row => row.map(quote).join(',')).join('\r\n')}\r\n`;
  }

  function addressKeys(row) {
    return new Set(row.addresses.filter(Boolean).map(address => {
      const local = stripProvince(address, row.province);
      const withoutDistrict = row.district && local.startsWith(row.district) ? local.slice(row.district.length) : local;
      return withoutDistrict.replace(/\([^)]*\)|\[[^\]]*\]/gu, '').replace(/[‐‑–—]/gu, '-').toLowerCase();
    }).filter(address => /\d/u.test(address)));
  }

  function normalizedName(name) {
    return compact(name).replace(/\(주\)|㈜|주식회사|[^\p{L}\p{N}]/gu, '').toLowerCase();
  }

  function indexAddresses(items) {
    const index = new Map();
    for (const [item, keys] of items) {
      for (const key of keys) {
        if (!index.has(key)) index.set(key, new Set());
        index.get(key).add(item);
      }
    }
    return index;
  }

  const addressIndexKey = (row, address) => `${row.province}\t${cityParent(row.district)}\t${address}`;

  function connectPrices(stations, prices) {
    const groups = new Map();
    const stationKeys = new Map(stations.map(station => [station, [...addressKeys(station)].map(key => addressIndexKey(station, key))]));
    const stationIndex = indexAddresses(stationKeys);
    for (const row of prices) {
      if (!groups.has(row.id)) groups.set(row.id, { rows: [], names: new Set(), keys: new Set() });
      const group = groups.get(row.id);
      group.rows.push(row);
      group.names.add(normalizedName(row.name));
      for (const key of addressKeys(row)) group.keys.add(addressIndexKey(row, key));
    }
    const priceIndex = indexAddresses([...groups.values()].map(group => [group, group.keys]));
    const proposals = new Map();
    for (const group of groups.values()) {
      const possible = new Set();
      for (const key of group.keys) {
        for (const station of stationIndex.get(key) ?? []) {
          if (group.rows.some(row => row.province === station.province &&
            (row.district === station.district || row.district === cityParent(station.district) || cityParent(row.district) === station.district))) possible.add(station);
        }
      }
      if (group.names.size !== 1) continue;
      const name = group.names.values().next().value;
      const nameMatches = [...possible].filter(station => normalizedName(station.name) === name && name);
      let match = nameMatches.length === 1 ? nameMatches[0] : null;
      if (!match && !nameMatches.length && possible.size === 1) {
        const candidate = possible.values().next().value;
        const candidateName = normalizedName(candidate.name);
        if ((!candidateName || !name) && stationKeys.get(candidate).some(key => group.keys.has(key) &&
          stationIndex.get(key).size === 1 && priceIndex.get(key).size === 1)) match = candidate;
      }
      if (match) {
        if (!proposals.has(match)) proposals.set(match, []);
        proposals.get(match).push(group);
      }
    }
    const byStation = new Map();
    let matchedRows = 0;
    for (const [station, candidates] of proposals) {
      if (candidates.length !== 1) continue;
      const rows = candidates[0].rows.sort((a, b) => b.date.localeCompare(a.date));
      const signatures = new Map(), conflictingDates = new Set();
      for (const row of rows) {
        const signature = row.prices.map(value => value === '' ? '' : Number(value)).join(',');
        if (signatures.has(row.date) && signatures.get(row.date) !== signature) conflictingDates.add(row.date);
        signatures.set(row.date, signature);
      }
      byStation.set(station, { rows, conflictingDates });
      matchedRows += rows.length;
    }
    return { byStation, unmatched: prices.length - matchedRows };
  }

  const data = { connectPrices, coverage, createCatalog, exportCsv, fuels, initialRegion, inRegion, readDataset, regionOptions, unresolvedForDistrict };
  if (typeof module === 'object') module.exports = data;
  else globalThis.fuelData = data;
})();
