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
}
