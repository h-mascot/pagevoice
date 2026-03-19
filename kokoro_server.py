from fastapi import FastAPI, Request
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from kokoro import KPipeline
import soundfile as sf
import io

app = FastAPI()

# Enable CORS for the Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Kokoro Pipeline (American English by default)
print("Loading Kokoro pipeline...")
pipeline = KPipeline(lang_code='a')
print("Kokoro pipeline loaded.")

@app.post("/v1/text-to-speech/{voice_id}")
async def generate_speech(voice_id: str, request: Request):
    data = await request.json()
    text = data.get("text", "")
    speed = data.get("speed", 1)
    
    if not text:
        return Response(status_code=400, content="Missing text")

    try:
        speed = max(0.5, min(3.0, float(speed)))
    except (TypeError, ValueError):
        speed = 1.0
        
    print(f"Generating audio for voice '{voice_id}', text length: {len(text)}, speed: {speed}")
    
    # Generate audio
    # Using split_pattern to handle multi-sentence
    generator = pipeline(text, voice=voice_id, speed=speed, split_pattern=r'\n+')
    
    # Concatenate audio pieces
    all_audio = []
    for i, (gs, ps, audio) in enumerate(generator):
        all_audio.append(audio)
        
    if not all_audio:
        return Response(status_code=500, content="Failed to generate audio")
        
    # Combine the arrays
    import numpy as np
    combined_audio = np.concatenate(all_audio)
    
    # Write to in-memory WAV file
    buffer = io.BytesIO()
    sf.write(buffer, combined_audio, 24000, format='wav')
    buffer.seek(0)
    
    return Response(content=buffer.read(), media_type="audio/wav")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8881)
