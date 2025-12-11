"use client"

import { useEffect, useRef, useState } from "react"
import type { LatLngTuple, Control, Map as LeafletMap, Layer, GeoJSON as LeafletGeoJSON, PathOptions } from "leaflet"
import type { Region } from "@/lib/regions"
import { REGION_WOREDAS } from "@/lib/regions"
import { canonicalWoredaName } from "@/lib/canonical"

type Props = {
  region?: Region
  woreda?: string
  disableInteraction?: boolean
  onSelectWoreda?: (w: string) => void
  monthIndex?: number
  predictions?: number[]
  predictionsByWoreda?: Record<string, number[]>
  allowedWoredas?: string[]
  points?: { lat: number; lon: number; prediction: number[]; shap_values?: any }[]
  loading?: boolean
  showRegions?: Region[]
}

export function DroughtMap({ region, woreda, disableInteraction, onSelectWoreda, monthIndex = 0, predictions = [], predictionsByWoreda = {}, allowedWoredas, points = [], loading = false, showRegions }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<LeafletMap | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)
  const legendRef = useRef<Control | null>(null)
  const loadingRef = useRef<HTMLDivElement | null>(null)
  const pointsLayerRef = useRef<Layer | null>(null)
  const basePointsLayerRef = useRef<Layer | null>(null)
  const regionLayerRef = useRef<any | null>(null)
  const geojsonCache = useRef<Record<Region, any | null>>({ afar: null, somali: null })
  const [ready, setReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const lastFitKeyRef = useRef<string | null>(null)
  const lastNonEmptyPtsRef = useRef<{ lat: number; lon: number; prediction: number[] }[] | null>(null)
  const selectedWoredaGeomRef = useRef<any | null>(null)
  const boundaryReadyRef = useRef<boolean>(false)
  const internalLoadingRef = useRef<boolean>(false)
  // Freeze markers where they first loaded for a given (region,woreda)
  const frozenKeyRef = useRef<string | null>(null)
  const frozenPointsRef = useRef<{ lat: number; lon: number; prediction: number[] }[] | null>(null)

  // Central canonical function imported; keep a tiny shim for backward compatibility if needed.
  const normalizeWoredaName = (name?: string) => canonicalWoredaName(name)

  const CLASS_COLORS = {
    extreme: '#dc2626',
    severe: '#f97316',
    moderate: '#eab308',
    normal: '#22c55e',
    nodrought: '#3b82f6',
  }

  useEffect(() => {
    if (!mapRef.current) return

    let cancelled = false
    const initMap = async () => {
      const L = (await import("leaflet")).default
      if (cancelled) return
      const container = mapRef.current
      if (!container || !container.isConnected) return

      if (!document.querySelector('link[href*="leaflet.css"]')) {
        const link = document.createElement("link")
        link.rel = "stylesheet"
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        document.head.appendChild(link)
      }

      if (!mapInstance.current) {
        try {
          mapInstance.current = L.map(container, {
            center: [9.5, 42.0],
            zoom: 6,
            zoomControl: true,
            attributionControl: false,
            maxBoundsViscosity: 1.0,
          })
        } catch (e) {
          // If container disappeared during async load, abort silently
          return
        }

        // Hide map container initially to prevent showing background tiles
        container.style.visibility = 'hidden'
        container.style.opacity = '0'
        
        // Base map tiles removed - not needed for overlay-only display

        const invalidate = () => mapInstance.current && mapInstance.current.invalidateSize()
        mapInstance.current.whenReady(invalidate)
        setTimeout(invalidate, 0)
        roRef.current = new ResizeObserver(() => invalidate())
        roRef.current.observe(container)
        window.addEventListener("resize", invalidate)
        
        // Add zoom event listener to re-render squares with correct ground size
        mapInstance.current.on('zoomend', () => {
          // Re-render squares when zoom changes to maintain ground-consistent size
          if (basePointsLayerRef.current && mapInstance.current) {
            setTimeout(() => {
              renderPointMarkers()
            }, 50) // Small delay to ensure zoom is complete
          }
        })

        const legend = (L as any).control({ position: "bottomright" }) as Control
        ;(legend as any).onAdd = () => {
          const div = L.DomUtil.create("div", "legend")
          div.className = "leaflet-control bg-white/95 dark:bg-gray-800/90 backdrop-blur rounded-md shadow border border-gray-300 dark:border-gray-600 p-3 text-xs max-w-[220px] text-gray-800 dark:text-gray-100";
          div.innerHTML = `
            <div class='font-semibold mb-2'>Point SPEI (per grid)</div>
            <div class='flex items-center gap-2 mb-1'><span class='w-3 h-3 rounded border border-gray-400/50' style='background:${CLASS_COLORS.extreme}'></span><span>Extreme Drought</span></div>
            <div class='flex items-center gap-2 mb-1'><span class='w-3 h-3 rounded border border-gray-400/50' style='background:${CLASS_COLORS.severe}'></span><span>Severe Drought</span></div>
            <div class='flex items-center gap-2 mb-1'><span class='w-3 h-3 rounded border border-gray-400/50' style='background:${CLASS_COLORS.moderate}'></span><span>Moderate Drought</span></div>
            <div class='flex items-center gap-2 mb-1'><span class='w-3 h-3 rounded border border-gray-400/50' style='background:${CLASS_COLORS.normal}'></span><span>Normal</span></div>
            <div class='flex items-center gap-2 mb-1'><span class='w-3 h-3 rounded border border-gray-400/50' style='background:${CLASS_COLORS.nodrought}'></span><span>No Drought</span></div>
          `
          return div
        }
        legend.addTo(mapInstance.current)
        legendRef.current = legend

  const loading = document.createElement("div")
  loading.className = "absolute inset-0 flex items-center justify-center pointer-events-none z-[1001]"
        loading.innerHTML = `
          <div class='bg-white/80 dark:bg-gray-900/80 p-2 rounded shadow flex items-center justify-center'>
            <svg class='animate-spin h-5 w-5 text-gray-700 dark:text-gray-200' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
              <circle class='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' stroke-width='4'></circle>
              <path class='opacity-75' fill='currentColor' d='M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z'></path>
            </svg>
          </div>`
        loading.style.display = "none"
        container.appendChild(loading)
        loadingRef.current = loading
         // Create dedicated panes for layering
         try {
           if (mapInstance.current && !(mapInstance.current as any)._panes?.pointsPane) {
             mapInstance.current.createPane('pointsPane')
             const pane = (mapInstance.current.getPane('pointsPane') as any)
             if (pane) pane.style.zIndex = 650 // above markerPane(600)
           }
           if (mapInstance.current && !(mapInstance.current as any)._panes?.boundaryPane) {
             mapInstance.current.createPane('boundaryPane')
             const pane = (mapInstance.current.getPane('boundaryPane') as any)
             if (pane) pane.style.zIndex = 500 // below pointsPane(650)
           }
           if (mapInstance.current && !(mapInstance.current as any)._panes?.tooltipPane) {
             mapInstance.current.createPane('tooltipPane')
             const pane = (mapInstance.current.getPane('tooltipPane') as any)
             if (pane) pane.style.zIndex = 3000 // highest layer for tooltips - above everything on map
           }
         } catch {}
        setMapReady(true)
      }
    }

    initMap()

    return () => {
      cancelled = true
      if (mapInstance.current && roRef.current && mapRef.current) {
        try { roRef.current.unobserve(mapRef.current) } catch {}
      }
    }
  }, [])

  const setLoading = (val: boolean) => {
    if (loadingRef.current) {
      loadingRef.current.style.display = val ? "flex" : "none"
      // Ensure spinner-only content (no text)
      loadingRef.current.innerHTML = `
        <div class='bg-white/80 dark:bg-gray-900/80 p-2 rounded shadow flex items-center justify-center'>
          <svg class='animate-spin h-5 w-5 text-gray-700 dark:text-gray-200' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <circle class='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' stroke-width='4'></circle>
            <path class='opacity-75' fill='currentColor' d='M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z'></path>
          </svg>
        </div>`
    }
  }
  const recomputeOverlay = () => {
    const show = internalLoadingRef.current || !!loading
    setLoading(show)
  }
  useEffect(() => { recomputeOverlay() }, [loading, region, woreda])

  // Clear point layers immediately when external loading starts so previous predictions disappear
  const clearPointLayers = () => {
    if (!mapInstance.current) return
    if (basePointsLayerRef.current) {
      try {
        (basePointsLayerRef.current as any).eachLayer?.((l: any) => { try { l.unbindTooltip?.(); l.unbindPopup?.() } catch {} })
        mapInstance.current.removeLayer(basePointsLayerRef.current)
      } catch {}
      basePointsLayerRef.current = null
    }
    if (pointsLayerRef.current) {
      try {
        (pointsLayerRef.current as any).eachLayer?.((l: any) => { try { l.unbindTooltip?.(); l.unbindPopup?.() } catch {} })
        mapInstance.current.removeLayer(pointsLayerRef.current)
      } catch {}
      pointsLayerRef.current = null
    }
  }
  useEffect(() => {
    if (loading) {
      clearPointLayers()
    }
  }, [loading])

  // Load and render region shapefile outlines as non-filled boundaries
  const ensureRegionLayer = async () => {
    if (!mapInstance.current) return
    const L = (await import("leaflet")).default
    internalLoadingRef.current = true
    recomputeOverlay()
    try {
      boundaryReadyRef.current = false

      // Determine which regions to show: prefer explicit showRegions prop, otherwise single region
  const regionsToShow: Region[] = (Array.isArray(showRegions) && showRegions.length > 0) ? showRegions : (region ? [region] : [])
      // Backwards-compat: if no explicit prop, but region is present, we show that one
      // If still empty, nothing to do
      if (regionsToShow.length === 0) return

      // Clear previous
      if (regionLayerRef.current) {
        try { mapInstance.current.removeLayer(regionLayerRef.current) } catch {}
        regionLayerRef.current = null
      }

      const group = L.layerGroup()

      const turf = await import('@turf/turf')

      const nameOf = (f: any): string => {
        const p = f?.properties || {}
        return canonicalWoredaName(p.name || p.NAME || p.ADM3_EN || p.ADM3NAME || p.ADM_NAME || p.Woreda || p.WOREDA || p.woreda || p.W_NAME || '')
      }

      for (const r of regionsToShow) {
        if (!geojsonCache.current[r]) {
          const rawPath = r === 'afar' ? '/geo/afar_woredas (1).geojson' : '/geo/somali_woredas (1).geojson'
          const url = encodeURI(rawPath)
          const resp = await fetch(url)
          if (!resp.ok) continue
          geojsonCache.current[r] = await resp.json()
        }
        const data = geojsonCache.current[r]
        const allowed = Array.isArray(REGION_WOREDAS[r]) ? REGION_WOREDAS[r] : []

        // Render woreda polygons (filtered to allowed list)
        try {
          const woredaLayer = L.geoJSON(data, {
            filter: (feature: any) => {
              const n = nameOf(feature)
              return allowed.some(a => canonicalWoredaName(a).toLowerCase() === n.toLowerCase())
            },
            style: (): PathOptions => ({ color: '#2563eb', weight: 1.2, fillOpacity: 0.03, fill: true, pane: 'boundaryPane' as any, interactive: true })
          } as any)

          woredaLayer.eachLayer((l: any) => {
            try {
              l.on && l.on('click', () => {
                const n = nameOf(l.feature)
                if (onSelectWoreda) onSelectWoreda(n)
                try { const b = l.getBounds?.(); if (b && b.isValid && b.isValid()) mapInstance.current!.fitBounds(b, { padding: [40,40], maxZoom: 12 }) } catch {}
              })
            } catch {}
          })
          group.addLayer(woredaLayer)
        } catch {}

        // Build a union/outline for the whole region using turf
        try {
          const feats = (data && data.features) ? data.features : []
          let unionGeom: any = null
          for (const f of feats) {
            try {
              const feat = turf.default ? turf.default.feature(f.geometry, f.properties) : f
              if (!unionGeom) unionGeom = feat
              else {
                // union may fail for some pairs; wrap in try
                try { unionGeom = turf.union(unionGeom, feat) } catch { /* ignore union errors for complex features */ }
              }
            } catch {}
          }
          if (unionGeom) {
            const outline = L.geoJSON(unionGeom, { style: (): PathOptions => ({ color: '#0ea5e9', weight: 3, fillOpacity: 0, pane: 'boundaryPane' as any, interactive: false }) } as any)
            group.addLayer(outline)
          }
        } catch {}
      }

      try { group.addTo(mapInstance.current); regionLayerRef.current = group } catch { regionLayerRef.current = null }

      // If no woreda is selected, fit the map to the combined region group bounds
      if (!woreda && regionLayerRef.current) {
        try {
          const bounds = (regionLayerRef.current as any).getBounds ? (regionLayerRef.current as any).getBounds() : null
          if (bounds && bounds.isValid && bounds.isValid()) {
            try { mapInstance.current!.fitBounds(bounds, { padding: [40,40], maxZoom: 8 }) } catch {}
          }
        } catch {}
      }

      // If a woreda was selected, try to find it and fit to its bounds
      if (woreda && regionLayerRef.current) {
        try {
          regionLayerRef.current.eachLayer((layer: any) => {
            try {
              if (layer.eachLayer) {
                layer.eachLayer((l: any) => {
                  const raw = canonicalWoredaName(l?.feature?.properties?.name || l?.feature?.properties?.ADM3_EN || '')
                  if (raw && canonicalWoredaName(raw).toLowerCase() === canonicalWoredaName(woreda).toLowerCase()) {
                    selectedWoredaGeomRef.current = l.toGeoJSON()?.geometry || null
                    const b = l.getBounds?.()
                    if (b && b.isValid && b.isValid()) {
                      try { mapInstance.current!.fitBounds(b, { padding: [40, 40], maxZoom: 11 }) } catch {}
                    }
                  }
                })
              }
            } catch {}
          })
        } catch {}
      }

  boundaryReadyRef.current = true
      try { await renderPointMarkers() } catch {}
    } finally {
      internalLoadingRef.current = false
      recomputeOverlay()
    }
  }
  // Render per-point markers colored by SPEI for the selected month; no shapefile overlays
  const renderPointMarkers = async () => {
    if (!mapInstance.current) return
    const L = (await import("leaflet")).default
    // Lazy-load turf only if we have a boundary to filter
    const hasBoundary = !!selectedWoredaGeomRef.current
    const turf = hasBoundary ? await import('@turf/turf') : null

    const month = monthIndex ?? 0
    // Build a freeze key for the current selection
    const freezeKey = `${region || ''}:${normalizeWoredaName(woreda) || 'none'}`
    // Prefer fresh points for the current woreda; do NOT fall back to previous woreda
    const hasCurrent = Array.isArray(points) && points.length > 0
    const srcPoints = hasCurrent
      ? points
      : (frozenKeyRef.current === freezeKey && frozenPointsRef.current?.length
        ? frozenPointsRef.current!
        : [])
    // Build full points (with predictions) and month-view points
    let currentFull = srcPoints.filter(p => Array.isArray(p.prediction) && p.prediction.length > month)

    // Heuristic: some upstream points may have lat/lon swapped. Ethiopia bounds ~ lat[3,16], lon[33,49].
    // If most points fall inside when swapped but outside when not, swap them (one time per render input).
    const withinEth = (la: number, lo: number) => la >= 3 && la <= 16 && lo >= 33 && lo <= 49
    if (currentFull.length) {
      let inNormal = 0, inSwapped = 0
      for (const p of currentFull) {
        if (withinEth(p.lat, p.lon)) inNormal++
        if (withinEth(p.lon, p.lat)) inSwapped++
      }
      if (inSwapped > inNormal && inSwapped >= Math.max(3, Math.floor(currentFull.length * 0.5))) {
        currentFull = currentFull.map(p => ({ lat: p.lon, lon: p.lat, prediction: p.prediction }))
        try { console.warn('[map] swapped lat/lon for prediction points based on bounds heuristic') } catch {}
      }
    }
    // Determine or set frozen points keyed by (region,woreda) only when we have fresh points for this key
    if ((!frozenPointsRef.current || frozenKeyRef.current !== freezeKey) && hasCurrent) {
      if (currentFull.length) {
        frozenPointsRef.current = currentFull
        frozenKeyRef.current = freezeKey
      }
    }
    const baseFull = (frozenKeyRef.current === freezeKey && frozenPointsRef.current?.length) ? frozenPointsRef.current! : currentFull
    let pts = baseFull
      .map(p => ({ lat: p.lat, lon: p.lon, value: Number(p.prediction[month]) }))
      .filter(p => Number.isFinite(p.value))

    // Heuristic: some upstream points may have lat/lon swapped. Ethiopia bounds ~ lat[3,16], lon[33,49].
    // If most points fall inside when swapped but outside when not, swap them.
    if (pts.length) {
      let inNormal = 0, inSwapped = 0
      for (const p of pts) {
        if (withinEth(p.lat, p.lon)) inNormal++
        if (withinEth(p.lon, p.lat)) inSwapped++
      }
      if (inSwapped > inNormal && inSwapped >= Math.max(3, Math.floor(pts.length * 0.5))) {
        // Swap lat/lon for all pts
        pts = pts.map(p => ({ lat: p.lon, lon: p.lat, value: p.value }))
        try { console.warn('[map] swapped lat/lon for prediction points based on bounds heuristic') } catch {}
      }
    }

    // If we still have no points for this woreda, clear layers and wait for data
    if (!pts.length) {
      // Remove any previous layers to avoid showing stale markers
      if (basePointsLayerRef.current) {
        try {
          (basePointsLayerRef.current as any).eachLayer?.((l: any) => { try { l.unbindTooltip?.(); l.unbindPopup?.() } catch {} })
          mapInstance.current!.removeLayer(basePointsLayerRef.current)
        } catch {}
        basePointsLayerRef.current = null
      }
      if (pointsLayerRef.current) {
        try {
          (pointsLayerRef.current as any).eachLayer?.((l: any) => { try { l.unbindTooltip?.(); l.unbindPopup?.() } catch {} })
          mapInstance.current!.removeLayer(pointsLayerRef.current)
        } catch {}
        pointsLayerRef.current = null
      }
      setReady(true)
      // Show map container only when overlays are ready
      if (mapRef.current && mapInstance.current) {
        mapRef.current.style.visibility = 'visible'
      }
      return
    }
    // Do NOT clip after freezing positions—keep markers where they first loaded
    // Record last non-empty raw points
    if (hasCurrent) {
      lastNonEmptyPtsRef.current = points
    }

    const colorFor = (v: number) => {
      const cls = classify(v)
      return cls === 'Extreme Drought' ? CLASS_COLORS.extreme : cls === 'Severe Drought' ? CLASS_COLORS.severe : cls === 'Moderate Drought' ? CLASS_COLORS.moderate : cls === 'Normal' ? CLASS_COLORS.normal : CLASS_COLORS.nodrought
    }

    // Function to generate dense grid points for full coverage
    const generateDenseGrid = (originalPoints: typeof pts, boundary: any) => {
      if (!boundary || !turf || originalPoints.length === 0) return originalPoints
      
      try {
        // Get bounds of the original points
        const lats = originalPoints.map(p => p.lat)
        const lons = originalPoints.map(p => p.lon)
        const minLat = Math.min(...lats)
        const maxLat = Math.max(...lats)
        const minLon = Math.min(...lons)
        const maxLon = Math.max(...lons)
        
        // Create dense grid spacing for full coverage - slightly smaller than square size for overlap
        const gridSpacing = 0.003 // Dense spacing to ensure no gaps, creates slight overlap
        
        const gridPoints: typeof pts = []
        
        // Generate dense grid points
        for (let lat = minLat; lat <= maxLat; lat += gridSpacing) {
          for (let lon = minLon; lon <= maxLon; lon += gridSpacing) {
            const point = turf.point([lon, lat])
            
            // Check if point is within boundary
            if (turf.booleanPointInPolygon(point, boundary)) {
              // Find nearest original point for interpolation
              const nearest = originalPoints.reduce((closest, p) => {
                const dist = Math.sqrt(Math.pow(p.lat - lat, 2) + Math.pow(p.lon - lon, 2))
                const closestDist = Math.sqrt(Math.pow(closest.lat - lat, 2) + Math.pow(closest.lon - lon, 2))
                return dist < closestDist ? p : closest
              })
              
              gridPoints.push({
                lat,
                lon,
                value: nearest.value
              })
            }
          }
        }
        
        return gridPoints.length > originalPoints.length ? gridPoints : originalPoints
      } catch (e) {
        return originalPoints
      }
    }

    // Render a single stable layer from the (possibly frozen) points
    const renderStableLayer = () => {
      // Always rebuild base layer so month/color updates reflect immediately
      if (basePointsLayerRef.current) {
        try {
          (basePointsLayerRef.current as any).eachLayer?.((l: any) => { try { l.unbindTooltip?.(); l.unbindPopup?.() } catch {} })
          mapInstance.current!.removeLayer(basePointsLayerRef.current)
        } catch {}
        basePointsLayerRef.current = null
      }
      // Generate dense grid for full coverage if we have a boundary
      const zoom = mapInstance.current?.getZoom() || 6
      const finalPoints = selectedWoredaGeomRef.current 
        ? generateDenseGrid(pts, selectedWoredaGeomRef.current) 
        : pts
      
      const g = L.layerGroup(undefined, { pane: 'pointsPane' } as any)
      
      // Calculate square size that gets bigger when zooming in
      // Bigger base size at zoom level 6 for full coverage, then scale up proportionally when zooming in
      const baseSize = 0.005 // degrees at zoom level 6 - bigger for full coverage
      const squareSize = baseSize * Math.pow(1.5, zoom - 6) // Scale up when zooming in
      
      finalPoints.forEach(({ lat, lon, value }) => {
        const color = Number.isFinite(value) ? colorFor(value) : '#64748b'
        
        // Create square marker using rectangle that scales up with zoom
        const halfSize = squareSize / 2
        const m = L.rectangle(
          [[lat - halfSize, lon - halfSize], [lat + halfSize, lon + halfSize]],
          { 
            color: 'transparent', 
            weight: 0, 
            fillColor: color, 
            fillOpacity: 1.0, 
            pane: 'pointsPane' as any,
            interactive: true
          }
        )
        
        try { 
          m.bindTooltip(`SPEI: ${Number.isFinite(value) ? value.toFixed(3) : '—'}`, { 
            sticky: true,
            direction: 'top',
            offset: [0, -15],
            opacity: 1.0,
            className: 'spei-tooltip',
            pane: 'tooltipPane'
          }) 
        } catch {}
        g.addLayer(m)
      })
      g.addTo(mapInstance.current!)
      basePointsLayerRef.current = g
      try { (basePointsLayerRef.current as any)?.bringToFront?.() } catch {}
      // Ensure any previous clipped layer is removed so we render only one stable layer
      if (pointsLayerRef.current) {
        try {
          (pointsLayerRef.current as any).eachLayer?.((l: any) => { try { l.unbindTooltip?.(); l.unbindPopup?.() } catch {} })
          mapInstance.current!.removeLayer(pointsLayerRef.current)
        } catch {}
        pointsLayerRef.current = null
      }
    }
    renderStableLayer()

    // Fit map to points/boundary when the data set changes (debounced by key)
    try {
      const key = `${woreda || 'none'}:${month}:${pts.length}:${hasBoundary ? 'B' : 'N'}`
      if (lastFitKeyRef.current !== key) {
        if (hasBoundary && regionLayerRef.current) {
          // Prefer fitting to the selected woreda boundary if available
          try {
            regionLayerRef.current.eachLayer((l: any) => {
              const raw = canonicalWoredaName(l?.feature?.properties?.name || l?.feature?.properties?.ADM3_EN || '')
              if (raw && canonicalWoredaName(raw).toLowerCase() === canonicalWoredaName(woreda).toLowerCase()) {
                const b = l.getBounds?.()
                if (b && b.isValid && b.isValid()) {
                  mapInstance.current!.fitBounds(b, { padding: [40,40], maxZoom: 12 })
                }
              }
            })
          } catch {}
        } else {
          const latlngs: [number, number][] = pts.map(p => [p.lat, p.lon])
          const bounds = L.latLngBounds(latlngs as any)
          if (bounds.isValid()) mapInstance.current!.fitBounds(bounds, { padding: [40,40], maxZoom: 12 })
        }
        lastFitKeyRef.current = key
      }
    } catch {}

    setReady(true)
    // Show map container only when overlays are ready
    if (mapRef.current && mapInstance.current) {
      mapRef.current.style.visibility = 'visible'
    }
  }

  useEffect(() => {
    // If a woreda is selected, wait until boundary is loaded to render markers (prevents appear-then-disappear)
    if (!mapReady) return
    if (woreda) {
      if (boundaryReadyRef.current) renderPointMarkers()
      return
    }
    // No woreda selected: render with whatever points we have
    renderPointMarkers()
  }, [points, monthIndex, woreda, mapReady])

  // When region/woreda changes, (re)load the outlines
  useEffect(() => {
    // Reload boundary when region, showRegions or woreda changes. Previously this required `region` to be set;
    // allow running when showRegions is provided so admin overview (no region) loads correctly.
    const hasRegionsToShow = Array.isArray(showRegions) && showRegions.length > 0
    if (!mapReady || (!region && !hasRegionsToShow)) return
    // Reload boundary when region or woreda or showRegions changes
    ensureRegionLayer()
  }, [region, woreda, mapReady, showRegions])

  useEffect(() => {
    // no-op; kept to preserve dependency on region if needed for external selection UI
  }, [region])

  useEffect(() => {
    return () => {
      if (mapInstance.current) {
        try { mapInstance.current.remove() } catch {}
        mapInstance.current = null
      }
      if (roRef.current) {
        try { roRef.current.disconnect() } catch {}
        roRef.current = null
      }
    }
  }, [])

  const classify = (spei: number) => {
    if (spei <= -1.5) return 'Extreme Drought'
    if (spei <= -1) return 'Severe Drought'
    if (spei <= -0.5) return 'Moderate Drought'
    if (spei <= 0.5) return 'Normal'
    return 'No Drought'
  }
  const phaseOf = (cls: string) => cls === 'Extreme Drought' ? 'Alert' : (cls === 'Severe Drought' || cls === 'Moderate Drought') ? 'Warn' : 'Watch'

  const escapeHtml = (s: string) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return s.replace(/[&<>"']/g, (c) => map[c] ?? c)
  }

  // Sync visibility with ready state
  useEffect(() => {
    if (mapRef.current && mapInstance.current) {
      if (ready) {
        mapRef.current.style.visibility = 'visible'
        mapRef.current.style.opacity = '1'
      }
    }
  }, [ready])

  return (
    <div
      ref={mapRef}
      className={`relative w-full h-[500px] rounded-md border border-border overflow-hidden transition-opacity ${ready ? "opacity-100" : "opacity-0"} ${disableInteraction ? "pointer-events-none opacity-40" : ""}`}
      style={{ height: "500px", visibility: ready ? "visible" : "hidden" }}
    />
  )
}
