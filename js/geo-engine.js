/**
 * GeoEngine - Geospatial Calculations for Spatial Audio Cartography
 * Handles spherical distance, bearing, and geofencing math.
 */
export class GeoEngine {
  static EARTH_RADIUS_METERS = 6371000;

  /**
   * Helper to normalize any coordinate input (array, nested array, object) into a clean [lng, lat] pair.
   * @param {*} coord - [lng, lat], {lng, lat}, {lon, lat}, or nested arrays
   * @returns {[number, number]|null}
   */
  static toCoordPair(coord) {
    if (!coord) return null;
    if (Array.isArray(coord)) {
      if (coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number' && !isNaN(coord[0]) && !isNaN(coord[1])) {
        return [Number(coord[0]), Number(coord[1])];
      }
      // Unwrap nested array if present
      let cur = coord;
      while (Array.isArray(cur) && Array.isArray(cur[0])) {
        cur = cur[0];
      }
      if (Array.isArray(cur) && cur.length >= 2 && !isNaN(cur[0]) && !isNaN(cur[1])) {
        return [Number(cur[0]), Number(cur[1])];
      }
    } else if (typeof coord === 'object') {
      const lng = coord.lng ?? coord.lon ?? coord.longitude;
      const lat = coord.lat ?? coord.latitude;
      if (lng !== undefined && lat !== undefined && !isNaN(lng) && !isNaN(lat)) {
        return [Number(lng), Number(lat)];
      }
    }
    return null;
  }

  /**
   * Helper to flatten and normalize LineString vertices into an array of [lng, lat] pairs.
   * @param {Array} lineCoords - GeoJSON LineString or MultiLineString coordinates
   * @returns {Array<[number, number]>}
   */
  static extractLineVertices(lineCoords) {
    if (!lineCoords || !Array.isArray(lineCoords)) return [];

    // If already array of simple points
    if (lineCoords.length > 0 && typeof lineCoords[0][0] === 'number') {
      return lineCoords.map(pt => this.toCoordPair(pt)).filter(Boolean);
    }

    // Recursively flatten nested coordinate arrays (e.g. MultiLineString or nested rings)
    const result = [];
    const flatten = (arr) => {
      if (!Array.isArray(arr)) return;
      if (arr.length >= 2 && typeof arr[0] === 'number' && typeof arr[1] === 'number') {
        const pair = this.toCoordPair(arr);
        if (pair) result.push(pair);
      } else {
        for (const item of arr) {
          flatten(item);
        }
      }
    };
    flatten(lineCoords);
    return result;
  }

  /**
   * Calculate great-circle distance between two [lng, lat] points in meters (Haversine formula).
   * @param {[number, number]} coord1 - [lng, lat]
   * @param {[number, number]} coord2 - [lng, lat]
   * @returns {number} Distance in meters
   */
  static getDistance(coord1, coord2) {
    const c1 = this.toCoordPair(coord1);
    const c2 = this.toCoordPair(coord2);
    if (!c1 || !c2) return Infinity;

    const [lon1, lat1] = c1;
    const [lon2, lat2] = c2;

    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return this.EARTH_RADIUS_METERS * c;
  }

  /**
   * Calculate forward azimuth/bearing in degrees (0° = North, 90° = East)
   * @param {[number, number]} from - [lng, lat] (Listener)
   * @param {[number, number]} to - [lng, lat] (Sound source)
   * @returns {number} Bearing in degrees (-180 to 180)
   */
  static getBearing(from, to) {
    const c1 = this.toCoordPair(from);
    const c2 = this.toCoordPair(to);
    if (!c1 || !c2) return 0;

    const lon1 = this.toRadians(c1[0]);
    const lat1 = this.toRadians(c1[1]);
    const lon2 = this.toRadians(c2[0]);
    const lat2 = this.toRadians(c2[1]);

    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);

    const brng = Math.atan2(y, x);
    return ((brng * 180) / Math.PI + 360) % 360;
  }

  /**
   * Generate a GeoJSON Polygon circle around a center point for map radius rendering.
   * @param {[number, number]} center - [lng, lat]
   * @param {number} radiusMeters - Radius in meters
   * @param {number} steps - Number of polygon vertices (default: 64)
   * @returns {Object} GeoJSON geometry object
   */
  static createCirclePolygon(center, radiusMeters, steps = 64) {
    const lng = (Array.isArray(center) && !isNaN(center[0])) ? Number(center[0]) : 115.8605;
    const lat = (Array.isArray(center) && !isNaN(center[1])) ? Number(center[1]) : -31.9505;
    const safeRadius = (typeof radiusMeters === 'number' && !isNaN(radiusMeters) && radiusMeters > 0)
      ? radiusMeters
      : 60;
    const coords = [];
    const latRad = this.toRadians(lat);
    const lngRad = this.toRadians(lng);

    for (let i = 0; i <= steps; i++) {
      const angle = (i * 2 * Math.PI) / steps;
      const d = safeRadius / this.EARTH_RADIUS_METERS;

      const pLat = Math.asin(
        Math.sin(latRad) * Math.cos(d) +
          Math.cos(latRad) * Math.sin(d) * Math.cos(angle)
      );

      const pLng =
        lngRad +
        Math.atan2(
          Math.sin(angle) * Math.sin(d) * Math.cos(latRad),
          Math.cos(d) - Math.sin(latRad) * Math.sin(pLat)
        );

      coords.push([this.toDegrees(pLng), this.toDegrees(pLat)]);
    }

    return {
      type: 'Polygon',
      coordinates: [coords]
    };
  }

  static toRadians(deg) {
    return (deg * Math.PI) / 180;
  }

  static toDegrees(rad) {
    return (rad * 180) / Math.PI;
  }

  /**
   * Formats coordinates into clean DMS or standard decimal string.
   * Handles Point [lng, lat], Polygon arrays, or LineString paths safely.
   */
  static formatCoords(coords) {
    if (!coords || !Array.isArray(coords) || coords.length === 0) return '0.0000°, 0.0000°';

    let lngLat = coords;
    if (Array.isArray(coords[0])) {
      if (Array.isArray(coords[0][0])) {
        // Polygon -> format centroid
        lngLat = this.getPolygonCentroid(coords);
      } else {
        // LineString -> format start waypoint
        lngLat = coords[0];
      }
    }

    if (!lngLat || lngLat.length < 2 || typeof lngLat[0] !== 'number' || typeof lngLat[1] !== 'number') {
      return '0.0000°, 0.0000°';
    }

    const [lng, lat] = lngLat;
    return `${lat.toFixed(5)}°N, ${lng.toFixed(5)}°E`;
  }

  /**
   * Smooths incoming GPS coordinates against previous location to eliminate stationary jitter.
   * Uses adaptive weight alpha based on distance delta (small drift = heavy dampening, fast move = responsive).
   */
  static smoothCoordinates(prevCoords, newCoords, minDeltaMeters = 1.2) {
    if (!prevCoords || !Array.isArray(prevCoords)) return newCoords;
    if (!newCoords || !Array.isArray(newCoords)) return prevCoords;

    const dist = this.getDistance(prevCoords, newCoords);
    if (dist < minDeltaMeters) {
      // Stationary GPS noise / wander
      const alpha = 0.15;
      return [
        prevCoords[0] + (newCoords[0] - prevCoords[0]) * alpha,
        prevCoords[1] + (newCoords[1] - prevCoords[1]) * alpha
      ];
    } else if (dist < 15) {
      // Normal walking movement
      const alpha = 0.45;
      return [
        prevCoords[0] + (newCoords[0] - prevCoords[0]) * alpha,
        prevCoords[1] + (newCoords[1] - prevCoords[1]) * alpha
      ];
    } else {
      // Major jump / initial fix
      return newCoords;
    }
  }

  /**
   * Smooths compass heading degrees (0-360°) handling angular wraparound across the 0°/360° north boundary
   */
  static smoothHeading(prevHeading, newHeading, alpha = 0.25) {
    if (prevHeading === null || isNaN(prevHeading)) return newHeading;
    if (newHeading === null || isNaN(newHeading)) return prevHeading;

    let diff = newHeading - prevHeading;
    while (diff < -180) diff += 360;
    while (diff > 180) diff -= 360;

    const smoothed = prevHeading + diff * alpha;
    return ((smoothed % 360) + 360) % 360;
  }

  /**
   * Ray-casting algorithm to test if a [lng, lat] point is inside a GeoJSON Polygon ring.
   * @param {[number, number]} point - [lng, lat]
   * @param {Array<Array<number>>} ring - Array of [lng, lat] vertices
   * @returns {boolean}
   */
  static isPointInRing(point, ring) {
    const pt = this.toCoordPair(point);
    if (!pt || !ring || !Array.isArray(ring) || ring.length < 3) return false;
    const [x, y] = pt;
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p1 = this.toCoordPair(ring[i]);
      const p2 = this.toCoordPair(ring[j]);
      if (!p1 || !p2) continue;

      const xi = p1[0], yi = p1[1];
      const xj = p2[0], yj = p2[1];

      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }

    return inside;
  }

  /**
   * Tests if point is inside a GeoJSON Polygon or MultiPolygon geometry.
   * Supports exterior rings and hole exclusion.
   * @param {[number, number]} point - [lng, lat]
   * @param {Array} coords - GeoJSON Polygon (Array of rings) or MultiPolygon coordinates
   * @returns {boolean}
   */
  static isPointInPolygon(point, coords) {
    if (!coords || !Array.isArray(coords) || coords.length === 0) return false;

    // Check if MultiPolygon: coords is Array of Polygons
    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && Array.isArray(coords[0][0][0])) {
      return coords.some(poly => this.isPointInPolygon(point, poly));
    }

    // Standard Polygon: coords[0] is outer ring, coords[1..n] are holes
    const outerRing = coords[0];
    if (!this.isPointInRing(point, outerRing)) return false;

    // Ensure not inside any inner hole
    for (let h = 1; h < coords.length; h++) {
      if (this.isPointInRing(point, coords[h])) {
        return false; // inside a hole
      }
    }

    return true;
  }

  /**
   * Calculates the geometric centroid [lng, lat] of a polygon's exterior ring.
   * @param {Array} coords - GeoJSON Polygon coordinates
   * @returns {[number, number]} [lng, lat] centroid
   */
  static getPolygonCentroid(coords) {
    if (!coords || !Array.isArray(coords) || coords.length === 0) return [115.8605, -31.9505];
    
    // Unwrap nested arrays down to the vertex coordinate ring
    let ring = coords;
    while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
      ring = ring[0];
    }
    if (!Array.isArray(ring) || ring.length === 0) return [115.8605, -31.9505];

    let sumLng = 0;
    let sumLat = 0;
    let validCount = 0;

    for (let i = 0; i < ring.length; i++) {
      const pt = this.toCoordPair(ring[i]);
      if (pt) {
        sumLng += pt[0];
        sumLat += pt[1];
        validCount++;
      }
    }

    if (validCount === 0) return [115.8605, -31.9505];
    return [sumLng / validCount, sumLat / validCount];
  }

  /**
   * Calculates perimeter of a polygon in meters
   * @param {Array} coords - GeoJSON Polygon coordinates
   * @returns {number} Perimeter in meters
   */
  static calculatePolygonPerimeter(coords) {
    let ring = coords;
    while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
      ring = ring[0];
    }
    if (!Array.isArray(ring) || ring.length < 2) return 0;

    let total = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      total += this.getDistance(ring[i], ring[i + 1]);
    }
    return total;
  }

  /**
   * Calculates approximate area of a polygon in square meters
   * @param {Array} coords - GeoJSON Polygon coordinates
   * @returns {number} Area in m²
   */
  static calculatePolygonArea(coords) {
    let ring = coords;
    while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
      ring = ring[0];
    }
    if (!Array.isArray(ring) || ring.length < 3) return 0;

    let area = 0;
    const len = ring.length;
    for (let i = 0; i < len; i++) {
      const j = (i + 1) % len;
      const p1 = this.toCoordPair(ring[i]);
      const p2 = this.toCoordPair(ring[j]);
      if (!p1 || !p2) continue;

      const xi = this.toRadians(p1[0]);
      const yi = this.toRadians(p1[1]);
      const xj = this.toRadians(p2[0]);
      const yj = this.toRadians(p2[1]);

      area += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
    }
    area = (Math.abs(area) * this.EARTH_RADIUS_METERS * this.EARTH_RADIUS_METERS) / 4.0;
    return area;
  }

  /**
   * Calculates minimum distance in meters from a point to the nearest edge of a polygon.
   * @param {[number, number]} point - [lng, lat]
   * @param {Array} coords - GeoJSON Polygon coordinates
   * @returns {number} Distance in meters
   */
  static distanceToPolygon(point, coords) {
    if (this.isPointInPolygon(point, coords)) return 0;

    let ring = coords;
    while (Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
      ring = ring[0];
    }
    if (!Array.isArray(ring) || ring.length < 2) return Infinity;

    let minDistance = Infinity;

    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = this.toCoordPair(ring[i]);
      const p2 = this.toCoordPair(ring[i + 1]);
      if (!p1 || !p2) continue;

      const dist = this.distanceToSegment(point, p1, p2);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    return minDistance;
  }

  /**
   * Calculates distance in meters from a point to a line segment [p1, p2]
   */
  static distanceToSegment(p, p1, p2) {
    const pt = this.toCoordPair(p);
    const pt1 = this.toCoordPair(p1);
    const pt2 = this.toCoordPair(p2);
    if (!pt || !pt1 || !pt2) return Infinity;

    const x = pt[0], y = pt[1];
    const x1 = pt1[0], y1 = pt1[1];
    const x2 = pt2[0], y2 = pt2[1];

    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
      return this.getDistance(pt, pt1);
    }

    // Parameter t of projected point onto line segment
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    const proj = [x1 + t * dx, y1 + t * dy];

    return this.getDistance(pt, proj);
  }

  /**
   * Calculates minimum distance in meters from a point to a LineString (polyline path).
   * @param {[number, number]} point - [lng, lat]
   * @param {Array<Array<number>>} lineCoords - Array of [lng, lat] vertices
   * @returns {number} Distance in meters
   */
  static distanceToLineString(point, lineCoords) {
    const vertices = this.extractLineVertices(lineCoords);
    if (vertices.length < 2) return Infinity;
    const pt = this.toCoordPair(point);
    if (!pt) return Infinity;

    let minDistance = Infinity;

    for (let i = 0; i < vertices.length - 1; i++) {
      const p1 = vertices[i];
      const p2 = vertices[i + 1];
      const dist = this.distanceToSegment(pt, p1, p2);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    return minDistance;
  }

  /**
   * Finds the closest waypoint node along a LineString path
   * @param {[number, number]} point - [lng, lat]
   * @param {Array<Array<number>>} lineCoords - Array of [lng, lat]
   * @returns {{ index: number, coord: [number, number], distance: number }}
   */
  static findClosestWaypoint(point, lineCoords) {
    const vertices = this.extractLineVertices(lineCoords);
    const pt = this.toCoordPair(point) || [115.8605, -31.9505];
    if (vertices.length === 0) return { index: 0, coord: pt, distance: Infinity };

    let minDistance = Infinity;
    let closestIndex = 0;

    for (let i = 0; i < vertices.length; i++) {
      const d = this.getDistance(pt, vertices[i]);
      if (d < minDistance) {
        minDistance = d;
        closestIndex = i;
      }
    }

    return {
      index: closestIndex,
      coord: vertices[closestIndex] || pt,
      distance: minDistance
    };
  }

  /**
   * Calculates total spherical length of a LineString path in meters
   * @param {Array<Array<number>>} lineCoords - Array of [lng, lat]
   * @returns {number} Total distance in meters
   */
  static calculateLineLength(lineCoords) {
    const vertices = this.extractLineVertices(lineCoords);
    if (!vertices || vertices.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < vertices.length - 1; i++) {
      total += this.getDistance(vertices[i], vertices[i + 1]);
    }
    return total;
  }
}
