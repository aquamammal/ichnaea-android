import test from 'brittle'
import { snapCoords, PRECISION_KM_OPTIONS } from '../src/main/precision.js'

test('off (0) passes coordinates through unchanged', (t) => {
  const { lat, lng } = snapCoords(37.7749, -122.4194, 0)
  t.is(lat, 37.7749)
  t.is(lng, -122.4194)
})

test('non-positive / non-finite precision passes through', (t) => {
  t.is(snapCoords(1.2, 3.4, -5).lat, 1.2)
  t.is(snapCoords(1.2, 3.4, NaN).lat, 1.2)
})

test('snaps latitude onto a ~km/111 grid', (t) => {
  // 10 km => step = 10/111 ≈ 0.0900900...
  const { lat } = snapCoords(37.7749, -122.4194, 10)
  const step = 10 / 111
  t.ok(Math.abs(lat - Math.round(37.7749 / step) * step) < 1e-9)
})

test('coarser precision moves coordinates less precisely', (t) => {
  const fine = snapCoords(37.7749, -122.4194, 5)
  const coarse = snapCoords(37.7749, -122.4194, 50)
  // A 50 km grid is coarser than a 5 km grid, so the 50 km point is at least
  // as far from the raw input as the 5 km point.
  const distFine = Math.abs(fine.lat - 37.7749)
  const distCoarse = Math.abs(coarse.lat - 37.7749)
  t.ok(distCoarse >= distFine)
})

test('accepted precision options are 0/5/10/25/50', (t) => {
  t.alike(PRECISION_KM_OPTIONS, [0, 5, 10, 25, 50])
})

test('returns rounded grid points (multiples of step)', (t) => {
  const { lat } = snapCoords(51.5, 0.1, 10)
  const step = 10 / 111
  const ratio = lat / step
  t.ok(Math.abs(ratio - Math.round(ratio)) < 1e-9, 'lat is an exact grid multiple')
})

test('clamps snapped coordinates into valid geographic range', (t) => {
  const north = snapCoords(90, 0, 25)
  t.ok(north.lat <= 90, 'lat clamped to <= 90')
  const south = snapCoords(-90, -180, 25)
  t.ok(south.lat >= -90 && south.lng >= -180, 'negative bounds clamped')
  const east = snapCoords(36.87, 179.99, 50)
  t.ok(east.lng <= 180, 'lng clamped to <= 180')
})
