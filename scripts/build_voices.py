#!/usr/bin/env python3
"""Erzeugt die mitgelieferten Navigationsstimmen mit Piper (freie, neuronale Sprachsynthese).

Jede Stimme bekommt kurze Ansage-Bausteine („In 300 Metern“ + „rechts abbiegen“), die die App
zusammensetzt. So klingen die Ansagen gut und funktionieren ohne Internet.
Ausgabe: <out>/<stimme>/<baustein>.mp3 und <out>/index.json
"""
import json
import os
import subprocess
import sys
import urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "voices-build"
MODELS = os.environ.get("MODEL_DIR", "piper-models")
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/"

VOICES = [
    {"id": "thorsten", "name": "Thorsten", "desc": "männlich, klar", "model": "thorsten/high/de_DE-thorsten-high"},
    {"id": "kerstin", "name": "Kerstin", "desc": "weiblich, ruhig", "model": "kerstin/low/de_DE-kerstin-low"},
    {"id": "ramona", "name": "Ramona", "desc": "weiblich, freundlich", "model": "ramona/low/de_DE-ramona-low"},
    {"id": "karlsson", "name": "Karlsson", "desc": "männlich, tief", "model": "karlsson/low/de_DE-karlsson-low"},
    {"id": "eva", "name": "Eva", "desc": "weiblich, hell", "model": "eva_k/x_low/de_DE-eva_k-x_low"},
    {"id": "thorsten-gut", "name": "Thorsten gut gelaunt", "desc": "männlich, fröhlich", "model": "thorsten_emotional/medium/de_DE-thorsten_emotional-medium", "speaker": "amused"},
    {"id": "thorsten-leise", "name": "Thorsten flüsternd", "desc": "männlich, leise", "model": "thorsten_emotional/medium/de_DE-thorsten_emotional-medium", "speaker": "whisper"},
    {"id": "thorsten-muede", "name": "Thorsten müde", "desc": "männlich, verschlafen", "model": "thorsten_emotional/medium/de_DE-thorsten_emotional-medium", "speaker": "sleepy"},
]

PHRASES = {
    # Entfernungen
    "d50": "In 50 Metern", "d100": "In 100 Metern", "d150": "In 150 Metern", "d200": "In 200 Metern",
    "d250": "In 250 Metern", "d300": "In 300 Metern", "d400": "In 400 Metern", "d500": "In 500 Metern",
    "d600": "In 600 Metern", "d700": "In 700 Metern", "d800": "In 800 Metern", "d900": "In 900 Metern",
    "d1000": "In einem Kilometer", "d1500": "In anderthalb Kilometern", "d2000": "In 2 Kilometern",
    "d3000": "In 3 Kilometern", "d5000": "In 5 Kilometern",
    "now": "Jetzt",
    # Manöver
    "right": "rechts abbiegen.", "left": "links abbiegen.",
    "slight_right": "leicht rechts abbiegen.", "slight_left": "leicht links abbiegen.",
    "sharp_right": "scharf rechts abbiegen.", "sharp_left": "scharf links abbiegen.",
    "uturn": "wenden.", "straight": "geradeaus weiterfahren.",
    "keep_right": "rechts halten.", "keep_left": "links halten.",
    "exit_right": "die Ausfahrt rechts nehmen.", "exit_left": "die Ausfahrt links nehmen.",
    "ramp": "auf die Auffahrt fahren.", "merge": "einfädeln.", "ferry": "auf die Fähre fahren.",
    "rb": "in den Kreisverkehr fahren.",
    "rb1": "im Kreisverkehr die erste Ausfahrt nehmen.", "rb2": "im Kreisverkehr die zweite Ausfahrt nehmen.",
    "rb3": "im Kreisverkehr die dritte Ausfahrt nehmen.", "rb4": "im Kreisverkehr die vierte Ausfahrt nehmen.",
    "rb5": "im Kreisverkehr die fünfte Ausfahrt nehmen.", "rb6": "im Kreisverkehr die sechste Ausfahrt nehmen.",
    "dest": "erreichst du dein Ziel.", "via": "erreichst du deinen Zwischenstopp.",
    # ganze Sätze
    "arrived": "Du hast dein Ziel erreicht.", "via_reached": "Zwischenstopp erreicht.",
    "start": "Route gestartet. Gute Fahrt!", "reroute": "Route wird neu berechnet.",
    "line": "Luftlinie zum Ziel.", "voice_on": "Sprachansagen an.", "off_route": "Du hast die Route verlassen.",
    "hello": "Hallo! So klinge ich als deine Navigationsstimme.",
}


def fetch(path):
    os.makedirs(MODELS, exist_ok=True)
    local = os.path.join(MODELS, path.split("/")[-1])
    for ext in (".onnx", ".onnx.json"):
        if not os.path.exists(local + ext):
            print("lade", path + ext, flush=True)
            urllib.request.urlretrieve(HF + path + ext, local + ext)
    return local


def main():
    index = []
    for v in VOICES:
        try:
            model = fetch(v["model"])
        except Exception as e:
            print("Stimme übersprungen:", v["id"], e, flush=True)
            continue
        cfg = json.load(open(model + ".onnx.json"))
        args = ["piper", "--model", model + ".onnx", "--config", model + ".onnx.json"]
        if v.get("speaker"):
            sid = cfg.get("speaker_id_map", {}).get(v["speaker"])
            if sid is None:
                print("Sprecher fehlt:", v, flush=True)
                continue
            args += ["--speaker", str(sid)]
        d = os.path.join(OUT, v["id"])
        os.makedirs(d, exist_ok=True)
        ok = True
        for key, text in PHRASES.items():
            wav = f"/tmp/{v['id']}-{key}.wav"
            p = subprocess.run(args + ["--output_file", wav], input=text, text=True, capture_output=True)
            if p.returncode != 0 or not os.path.exists(wav):
                print("Fehler", v["id"], key, p.stderr[-300:], flush=True)
                ok = False
                break
            # Stille vorne und hinten abschneiden, als kleine MP3 speichern
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-af",
                            "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,apad=pad_dur=0.04",
                            "-ac", "1", "-ar", "22050", "-b:a", "48k", os.path.join(d, key + ".mp3")], check=True)
        if ok:
            index.append({"id": v["id"], "name": v["name"], "desc": v["desc"]})
            print("fertig:", v["name"], flush=True)
    json.dump({"v": 1, "voices": index, "keys": list(PHRASES)}, open(os.path.join(OUT, "index.json"), "w"), ensure_ascii=False)


if __name__ == "__main__":
    main()
