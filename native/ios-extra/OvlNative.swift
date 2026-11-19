// Overland-Navi: nativer Teil der iPhone-App.
// Wird im Bauvorgang an AppDelegate.swift angehängt (Imports UIKit, Capacitor, AVFoundation, CoreLocation stehen dort oben).
// - speak: Ansage-Bausteine (MP3 aus der App) oder einen Satz abspielen; Musik anderer Apps wird dabei leiser.
// - startNav/stopNav: während einer Route Standort im Hintergrund und Ansagen ohne die Webseite.

@objc(OvlNativePlugin)
public class OvlNativePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate, AVSpeechSynthesizerDelegate {
    public let identifier = "OvlNativePlugin"
    public let jsName = "OvlNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startNav", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopNav", returnType: CAPPluginReturnPromise)
    ]

    // ---------- Ton ----------
    private var player: AVQueuePlayer?
    private var endObserver: NSObjectProtocol?
    private let synth = AVSpeechSynthesizer()
    private var unduckWork: DispatchWorkItem?

    private func duck() {
        unduckWork?.cancel()
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        try? s.setActive(true)
    }
    private func unduckSoon() {
        unduckWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if self.synth.isSpeaking || self.player != nil { return }
            let s = AVAudioSession.sharedInstance()
            try? s.setActive(false, options: .notifyOthersOnDeactivation)
            try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        }
        unduckWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
    }
    private func stopAudio() {
        if let o = endObserver { NotificationCenter.default.removeObserver(o); endObserver = nil }
        player?.pause()
        player = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }
    /// spielt Bausteine hintereinander; Rückgabe: Dauer in Sekunden, nil wenn eine Datei fehlt
    private func playKeys(_ keys: [String], voice: String, rate: Float) -> Double? {
        var urls: [URL] = []
        for k in keys {
            guard let u = Bundle.main.url(forResource: k, withExtension: "mp3", subdirectory: "public/voices/\(voice)") else { return nil }
            urls.append(u)
        }
        if urls.isEmpty { return nil }
        stopAudio()
        duck()
        let items = urls.map { AVPlayerItem(url: $0) }
        for it in items { it.audioTimePitchAlgorithm = .timeDomain }
        let q = AVQueuePlayer(items: items)
        q.automaticallyWaitsToMinimizeStalling = false
        if let last = items.last {
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: last, queue: .main) { [weak self] _ in
                guard let self = self else { return }
                if let o = self.endObserver { NotificationCenter.default.removeObserver(o); self.endObserver = nil }
                self.player = nil
                self.unduckSoon()
            }
        }
        player = q
        q.playImmediately(atRate: rate)
        var d = 0.0
        for u in urls { let s = CMTimeGetSeconds(AVURLAsset(url: u).duration); if s.isFinite { d += s } }
        return d / Double(max(rate, 0.5))
    }
    private func sayText(_ text: String, voiceId: String, rate: Float) -> Double {
        stopAudio()
        duck()
        let u = AVSpeechUtterance(string: text)
        u.voice = (voiceId.isEmpty ? nil : AVSpeechSynthesisVoice(identifier: voiceId)) ?? AVSpeechSynthesisVoice(language: "de-DE")
        u.rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate)
        synth.delegate = self
        synth.speak(u)
        return Double(text.count) * 0.07 / Double(max(rate, 0.5))
    }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { unduckSoon() }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { unduckSoon() }

    /// Bausteine, sonst ganzer Satz mit der Gerätestimme
    @discardableResult
    private func announce(_ keys: [String], _ text: String) -> (Double, String) {
        if !voice.isEmpty && !keys.isEmpty, let d = playKeys(keys, voice: voice, rate: rate) { return (d, "Stimme") }
        if !text.isEmpty { return (sayText(text, voiceId: voiceId, rate: rate), "Gerätestimme") }
        return (0, "nichts")
    }

    @objc func info(_ call: CAPPluginCall) {
        call.resolve(["version": 2, "by": OvlNativeBoot.registeredBy, "background": Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []])
    }

    @objc func speak(_ call: CAPPluginCall) {
        let keys = (call.options["keys"] as? [String]) ?? []
        let v = call.getString("voice") ?? ""
        let vid = call.getString("voiceId") ?? ""
        let text = call.getString("text") ?? ""
        let r = Float(call.getDouble("rate") ?? 1)
        DispatchQueue.main.async {
            if !v.isEmpty && !keys.isEmpty, let d = self.playKeys(keys, voice: v, rate: r) {
                call.resolve(["dur": d, "how": "Stimme"]); return
            }
            if !text.isEmpty {
                call.resolve(["dur": self.sayText(text, voiceId: vid, rate: r), "how": "Gerätestimme"]); return
            }
            call.reject("Ansage fehlt")
        }
    }

    // ---------- Route im Hintergrund ----------
    private var lm: CLLocationManager?
    private var coords: [[Double]] = []
    private var cum: [Double] = []
    private var total: Double = 0
    private var mans: [[String: Any]] = []
    private var mSt: [Int] = []
    private var tolls: [[String: Any]] = []
    private var tSt: [Int] = []
    private var targetLat = 0.0, targetLon = 0.0
    private var joined = false
    private var voiceOn = true
    private var voice = ""
    private var voiceId = ""
    private var rate: Float = 1
    private var seg = 0
    private var offCount = 0
    private var offSaid = false
    private var arrived = false
    private var active = false

    private func readVoice(_ call: CAPPluginCall) {
        voiceOn = call.getBool("on") ?? true
        voice = call.getString("voice") ?? ""
        voiceId = call.getString("voiceId") ?? ""
        rate = Float(call.getDouble("rate") ?? 1)
    }
    private func num(_ x: Any?) -> Double { (x as? NSNumber)?.doubleValue ?? (x as? Double) ?? 0 }

    @objc func navVoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.readVoice(call); call.resolve() }
    }

    @objc func startNav(_ call: CAPPluginCall) {
        let raw = (call.options["coords"] as? [Any]) ?? []
        let c: [[Double]] = raw.compactMap { p in
            guard let a = p as? [Any], a.count >= 2 else { return nil }
            return [num(a[0]), num(a[1])]
        }
        let cm: [Double] = ((call.options["cum"] as? [Any]) ?? []).map { num($0) }
        guard c.count >= 2, cm.count == c.count else { call.reject("Route unvollständig"); return }
        let ms = (call.options["mans"] as? [[String: Any]]) ?? []
        let ts = (call.options["tolls"] as? [[String: Any]]) ?? []
        let tg = (call.options["target"] as? [String: Any]) ?? [:]
        let foot = call.getBool("foot") ?? false
        DispatchQueue.main.async {
            self.readVoice(call)
            self.coords = c; self.cum = cm
            self.total = self.num(call.options["total"])
            self.mans = ms; self.mSt = ms.map { Int(self.num($0["st"])) }
            self.tolls = ts; self.tSt = ts.map { Int(self.num($0["st"])) }
            self.targetLat = self.num(tg["lat"]); self.targetLon = self.num(tg["lon"])
            self.joined = call.getBool("joined") ?? false
            self.seg = 0; self.offCount = 0; self.offSaid = false; self.arrived = false; self.active = true
            if self.lm == nil {
                let m = CLLocationManager()
                m.delegate = self
                self.lm = m
            }
            guard let m = self.lm else { return }
            m.desiredAccuracy = kCLLocationAccuracyBestForNavigation
            m.distanceFilter = kCLDistanceFilterNone
            m.activityType = foot ? .fitness : .automotiveNavigation
            m.pausesLocationUpdatesAutomatically = false
            if m.authorizationStatus == .notDetermined { m.requestWhenInUseAuthorization() }
            let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
            if modes.contains("location") {
                m.allowsBackgroundLocationUpdates = true
                m.showsBackgroundLocationIndicator = true
            }
            m.startUpdatingLocation()
            call.resolve(["ok": true])
        }
    }

    @objc func stopNav(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.active = false
            if let m = self.lm {
                m.stopUpdatingLocation()
                m.allowsBackgroundLocationUpdates = false
            }
            call.resolve()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard active, let loc = locations.last, loc.horizontalAccuracy >= 0, loc.horizontalAccuracy < 100 else { return }
        step(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, speed: max(0, loc.speed))
    }

    // Abstand in Metern (flache Näherung, reicht für kurze Strecken)
    private func project(lat: Double, lon: Double) -> (i: Int, t: Double, d: Double) {
        let kx = 111320.0 * cos(lat * .pi / 180), ky = 110540.0
        var best = (i: 0, t: 0.0, d: Double.infinity)
        func scan(_ a: Int, _ b: Int) {
            let lo = max(0, a), hi = min(coords.count - 2, b)
            if lo > hi { return }
            for i in lo...hi {
                let ax = (coords[i][0] - lon) * kx, ay = (coords[i][1] - lat) * ky
                let bx = (coords[i + 1][0] - lon) * kx, by = (coords[i + 1][1] - lat) * ky
                let dx = bx - ax, dy = by - ay
                let l2 = dx * dx + dy * dy
                var t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0
                t = min(1, max(0, t))
                let px = ax + t * dx, py = ay + t * dy
                let d = (px * px + py * py).squareRoot()
                if d < best.d { best = (i, t, d) }
            }
        }
        scan(seg - 30, seg + 600)
        if best.d > 80 { scan(0, coords.count) }
        return best
    }
    private func distKey(_ d: Double) -> String {
        let steps: [Double] = [50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000, 1500, 2000, 3000, 5000]
        var best = steps[0]
        for s in steps where abs(s - d) < abs(best - d) { best = s }
        return "d\(Int(best))"
    }
    private func distText(_ d: Double) -> String {
        if d >= 1000 { let km = (d / 100).rounded() / 10; return km == km.rounded() ? "\(Int(km)) Kilometern" : String(format: "%.1f Kilometern", km).replacingOccurrences(of: ".", with: ",") }
        return "\(max(50, Int((d / 50).rounded()) * 50)) Metern"
    }
    private func meters(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let kx = 111320.0 * cos(lat1 * .pi / 180)
        let dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * 110540.0
        return (dx * dx + dy * dy).squareRoot()
    }

    private func step(lat: Double, lon: Double, speed: Double) {
        if arrived || coords.count < 2 { return }
        let p = project(lat: lat, lon: lon)
        seg = p.i
        if !joined { if p.d < 60 { joined = true } else { return } }
        let along = cum[p.i] + p.t * (cum[p.i + 1] - cum[p.i])
        let remaining = total - along
        if p.d > 60 { offCount += 1 } else { offCount = 0; offSaid = false }
        if remaining < 25 || (p.i >= coords.count - 2 && meters(lat, lon, targetLat, targetLon) < 40) {
            arrived = true
            if voiceOn { announce(["arrived"], "Du hast dein Ziel erreicht.") }
            return
        }
        if offCount >= 4 {
            // ohne die Webseite kann hier keine neue Route berechnet werden: einmal Bescheid sagen
            if !offSaid { offSaid = true; if voiceOn { announce(["off_route"], "Du hast die Route verlassen.") } }
            return
        }
        if offCount > 0 || !voiceOn { return }
        let fast = speed > 18
        for i in 0..<tolls.count where tSt[i] == 0 {
            let d = num(tolls[i]["at"]) - along
            if d > 0 && d < (fast ? 3000 : 1000) {
                tSt[i] = 1
                announce([distKey(d), "toll"], "In \(distText(d)) beginnt ein mautpflichtiger Abschnitt.")
                return
            }
        }
        guard let k = mans.firstIndex(where: { num($0["at"]) > along + 5 }) else { return }
        let m = mans[k]
        if (m["skip"] as? Bool) == true { return }
        let d = num(m["at"]) - along
        let st = mSt[k]
        let act = (m["act"] as? String) ?? "straight"
        let alert = (m["alert"] as? String) ?? ""
        let verbal = (m["verbal"] as? String) ?? ""
        if (m["tts"] as? Bool) == true {
            let t41 = (m["t41"] as? Bool) == true
            if st < 1 && d <= (t41 ? 600 : 80) { mSt[k] = 2; announce([], t41 ? "Gleich \(alert)." : verbal) }
            return
        }
        if st < 1 && d <= (fast ? 1500 : 500) && d > 150 {
            mSt[k] = 1
            announce([distKey(d), act], "In \(distText(d)) \(alert)")
        } else if st < 2 && d <= (fast ? 120 : 60) {
            mSt[k] = 2
            if act == "dest" { return }
            announce(act == "via" ? ["via_reached"] : ["now", act], verbal)
        }
    }
}

/// eigener View-Controller, damit der native Teil beim Start angemeldet wird
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OvlNativePlugin())
        OvlNativeBoot.registeredBy = "beim Start"
    }
}

/// Zweiter Weg: nach dem Start den Capacitor-View-Controller suchen und den nativen Teil dort anmelden,
/// falls der eigene View-Controller nicht benutzt wird (je nach Capacitor-Version)
enum OvlNativeBoot {
    nonisolated(unsafe) static var registeredBy = ""
    nonisolated(unsafe) static var observer: NSObjectProtocol?
    static func start() {
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in tryRegister() }
        for t in [0.3, 1.0, 3.0] { DispatchQueue.main.asyncAfter(deadline: .now() + t) { tryRegister() } }
    }
    static func tryRegister() {
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            for w in ws.windows {
                guard let vc = find(w.rootViewController), let b = vc.bridge else { continue }
                if b.plugin(withName: "OvlNative") == nil {
                    b.registerPluginInstance(OvlNativePlugin())
                    registeredBy = "nachträglich (" + String(describing: type(of: vc)) + ")"
                }
            }
        }
    }
    static func find(_ vc: UIViewController?) -> CAPBridgeViewController? {
        guard let vc = vc else { return nil }
        if let b = vc as? CAPBridgeViewController { return b }
        for c in vc.children { if let f = find(c) { return f } }
        return find(vc.presentedViewController)
    }
}
