/**
 * GeoEngine - Geospatial Calculations for Spatial Audio Cartography
 * Handles spherical distance, bearing, and geofencing math.
 */
export class GeoEngine {
  static EARTH_RADIUS_METERS = 6371000;

  /**
   * Calculate great-circle distance between two [lng, lat] points in meters (Haversine formula).
   * @param {[number, number]} coord1 - [lng, lat]
   * @param {[number, number]} coord2 - [lng, lat]
   * @returns {number} Distance in meters
   */
  static getDistance(coord1, coord2) {
    const [lon1, lat1] = coord1;
    const [lon2, lat2] = coord2;

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
    const [lon1, lat1] = from.map(this.toRadians);
    const [lon2, lat2] = to.map(this.toRadians);

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
   * Formats coordinates into clean DMS or standard decimal string
   */
  static formatCoords(coords) {
    if (!coords || coords.length < 2) return '0.0000°, 0.0000°';
    const [lng, lat] = coords;
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
    if (!ring || ring.length < 3) return false;
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];

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
    if (!coords || coords.length === 0) return [115.8605, -31.9505];
    const ring = Array.isArray(coords[0][0]) ? coords[0] : coords;
    let sumLng = 0;
    let sumLat = 0;
    const len = ring.length;

    for (let i = 0; i < len; i++) {
      sumLng += ring[i][0];
      sumLat += ring[i][1];
    }

    return [sumLng / len, sumLat / len];
  }

  /**
   * Calculates minimum distance in meters from a point to the nearest edge of a polygon.
   * @param {[number, number]} point - [lng, lat]
   * @param {Array} coords - GeoJSON Polygon coordinates
   * @returns {number} Distance in meters
   */
  static distanceToPolygon(point, coords) {
    if (this.isPointInPolygon(point, coords)) return 0;

    const ring = Array.isArray(coords[0][0]) ? coords[0] : coords;
    let minDistance = Infinity;

    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = ring[i];
      const p2 = ring[i + 1];
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
    const x = p[0], y = p[1];
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];

    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
      return this.getDistance(p, p1);
    }

    // Parameter t of projected point onto line segment
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    const proj = [x1 + t * dx, y1 + t * dy];

    return this.getDistance(p, proj);
  }
}
