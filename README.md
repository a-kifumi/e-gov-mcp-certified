<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/d05f6b66-e138-4813-86b7-d715298cea8b

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set `OPENROUTER_API_KEY` in [.env.local](.env.local)
3. Optional: override `OPENROUTER_PRIMARY_MODEL` and `OPENROUTER_FALLBACK_MODELS`
4. Run the app:
   `npm run dev`

## Model routing

- Primary model: `qwen/qwen3.6-plus:free`
- Default fallback: `stepfun/step-3.5-flash:free`
- Add more fallbacks by appending to `OPENROUTER_FALLBACK_MODELS` as a comma-separated list.
# e-gov-mcp-certified
