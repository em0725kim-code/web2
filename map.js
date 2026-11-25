(() => {
  const longitudeFactor = Math.cos(36 * Math.PI / 180);
  const project = ([lon, lat]) => [lon * longitudeFactor, -lat];

  class FuelMap {
    constructor(canvas, onSelect) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.onSelect = onSelect;
      this.markers = [];
      this.visible = [];
      this.zoom = 1;
      this.offset = [0, 0];
      this.size = [0, 0];
      this.path = new Path2D();
      this.bounds = null;
      this.frame = 0;
      new ResizeObserver(() => this.schedule()).observe(canvas);
      canvas.addEventListener('pointerdown', event => this.startDrag(event));
      canvas.addEventListener('pointermove', event => this.moveDrag(event));
      canvas.addEventListener('pointerup', event => this.endDrag(event));
      canvas.addEventListener('pointercancel', () => { this.drag = null; });
      canvas.addEventListener('wheel', event => {
        if (!this.bounds) return;
        event.preventDefault();
        this.magnify(event.deltaY < 0 ? 1.2 : 1 / 1.2, this.cursor(event));
      }, { passive: false });
    }

    setData(features, stations) {
      this.path = new Path2D();
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      const include = ([x, y]) => {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      };
      for (const { geometry } of features) {
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates ?? [];
        for (const polygon of polygons) {
          for (const ring of polygon) {
            for (const [index, coordinate] of ring.entries()) {
              const point = project(coordinate);
              include(point);
              if (index) this.path.lineTo(...point);
              else this.path.moveTo(...point);
            }
            this.path.closePath();
          }
        }
      }
      this.markers = stations.filter(station => station.point).map(station => ({ station, point: project(station.point) }));
      if (!Number.isFinite(bounds[0])) for (const { point } of this.markers) include(point);
      this.bounds = Number.isFinite(bounds[0]) ? bounds : null;
      this.select(null);
      this.reset();
    }

    select(station) {
      this.selected = station;
      this.schedule();
    }

    reset() {
      this.zoom = 1;
      this.offset = [0, 0];
      this.schedule();
    }

    magnify(factor, anchor = this.size.map(value => value / 2)) {
      const next = Math.max(0.6, Math.min(64, this.zoom * factor));
      this.offset = this.offset.map((value, index) => {
        const delta = anchor[index] - this.size[index] / 2;
        return delta + (value - delta) * next / this.zoom;
      });
      this.zoom = next;
      this.schedule();
    }

    cursor(event) {
      const rect = this.canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    }

    startDrag(event) {
      if (event.button !== 0 || !this.bounds || this.drag) return;
      this.drag = { id: event.pointerId, start: this.cursor(event), offset: [...this.offset], moved: false };
      this.canvas.setPointerCapture(event.pointerId);
    }

    moveDrag(event) {
      const [x, y] = this.cursor(event);
      if (this.drag?.id === event.pointerId) {
        const dx = x - this.drag.start[0], dy = y - this.drag.start[1];
        if (Math.hypot(dx, dy) > 5) this.drag.moved = true;
        if (this.drag.moved) {
          this.offset = [this.drag.offset[0] + dx, this.drag.offset[1] + dy];
          this.schedule();
        }
      }
      this.canvas.classList.toggle('over-marker', !this.drag?.moved && Boolean(this.hit(x, y)));
    }

    endDrag(event) {
      if (this.drag?.id !== event.pointerId) return;
      const { moved } = this.drag;
      this.drag = null;
      const marker = moved ? null : this.hit(...this.cursor(event));
      if (marker) this.onSelect(marker.station);
    }

    hit(x, y) {
      let distance = 12, hit = null;
      for (const marker of this.visible) {
        const next = Math.hypot(marker.x - x, marker.y - y);
        if (next <= distance) { hit = marker; distance = next; }
      }
      return hit;
    }

    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
    }

    draw() {
      const { canvas, context, bounds } = this;
      const width = canvas.clientWidth, height = canvas.clientHeight;
      this.size = [width, height];
      this.visible = [];
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) [canvas.width, canvas.height] = pixels;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!bounds) return;
      const [left, top, right, bottom] = bounds;
      const scale = Math.min(Math.max(1, width - 64) / Math.max(0.015, right - left), Math.max(1, height - 64) / Math.max(0.015, bottom - top)) * this.zoom;
      const dx = width / 2 - scale * (left + right) / 2 + this.offset[0];
      const dy = height / 2 - scale * (top + bottom) / 2 + this.offset[1];
      context.save();
      context.transform(scale, 0, 0, scale, dx, dy);
      context.fillStyle = '#e9e5da';
      context.strokeStyle = '#a19a8a';
      context.lineWidth = 0.7 / scale;
      context.fill(this.path, 'evenodd');
      context.stroke(this.path);
      context.restore();
      for (const { station, point: [px, py] } of this.markers) {
        const x = dx + px * scale, y = dy + py * scale;
        if (x >= -12 && x <= width + 12 && y >= -12 && y <= height + 12) this.visible.push({ station, x, y });
      }
      const current = this.visible.find(marker => marker.station === this.selected);
      for (const marker of this.visible) this.drawMarker(marker, false);
      if (current) this.drawMarker(current, true);
    }

    drawMarker({ x, y }, selected) {
      const context = this.context;
      context.beginPath();
      context.arc(x, y, selected ? 8 : 4.5, 0, Math.PI * 2);
      context.fillStyle = selected ? '#ffc827' : '#212121';
      context.fill();
      context.strokeStyle = selected ? '#212121' : '#ffffff';
      context.lineWidth = selected ? 2.5 : 1.25;
      context.stroke();
    }
  }

  globalThis.FuelMap = FuelMap;
})();
