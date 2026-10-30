// Experimental local contrastive evidence, not a calibrated automatic policy.
// Build against pinned whisper.cpp v1.7.5; see build-script-acoustic.sh.
// Input: one JSON object on stdin with model and bounded f32 PCM cases.
// Output: raw teacher-forced log-likelihoods on audio and silence, plus an
// independent, unprompted decode. Supplying text is NOT proof it was spoken.
#include "whisper.h"
#include "json.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::ordered_json;
using Context = std::unique_ptr<whisper_context, decltype(&whisper_free)>;

static void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

static std::vector<float> pcm(const std::string &path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    require(file.good(), "PCM file unavailable");
    const auto bytes = file.tellg();
    require(bytes >= 16000 * 4 && bytes <= 30 * 16000 * 4 && bytes % 4 == 0,
            "Expected 1–30 seconds of mono 16 kHz float32 PCM");
    std::vector<float> result(static_cast<size_t>(bytes) / sizeof(float));
    file.seekg(0);
    file.read(reinterpret_cast<char *>(result.data()), bytes);
    require(file.good(), "Incomplete PCM file");
    require(std::all_of(result.begin(), result.end(), [](float sample) {
        return std::isfinite(sample) && std::abs(sample) <= 1.01f;
    }), "Invalid PCM samples");
    return result;
}

static double log_probability(const float *logits, int vocabulary, int token) {
    const double maximum = *std::max_element(logits, logits + vocabulary);
    double sum = 0;
    for (int i = 0; i < vocabulary; ++i) sum += std::exp(logits[i] - maximum);
    const double result = logits[token] - maximum - std::log(sum);
    require(std::isfinite(result), "Nonfinite decoder score");
    return result;
}

static json score(whisper_context *ctx, const std::string &text) {
    require(!text.empty() && text.size() <= 4096, "Candidate text size limit");
    std::vector<whisper_token> text_tokens(448);
    const int count = whisper_tokenize(ctx, text.c_str(), text_tokens.data(), text_tokens.size());
    require(count > 0 && count < whisper_n_text_ctx(ctx) - 5, "Candidate token limit");
    text_tokens.resize(count);
    std::vector<whisper_token> tokens = {
        whisper_token_sot(ctx), whisper_token_lang(ctx, whisper_lang_id("en")),
        whisper_token_transcribe(ctx), whisper_token_not(ctx)
    };
    // n_past=0 starts a new decoder sequence for each alternative. The public
    // v1.7.5 API fills only the last logits row, so score autoregressively rather
    // than interpreting unfilled rows of a batch as token likelihoods.
    require(whisper_decode(ctx, tokens.data(), tokens.size(), 0, 4) == 0, "Decoder failed");
    const int vocabulary = whisper_n_vocab(ctx);
    json per_token = json::array();
    double total = 0;
    for (size_t i = 0; i <= text_tokens.size(); ++i) {
        const auto token = i == text_tokens.size() ? whisper_token_eot(ctx) : text_tokens[i];
        const float *logits = whisper_get_logits(ctx) + (i == 0 ? 3 * vocabulary : 0);
        const double probability = log_probability(logits, vocabulary, token);
        total += probability;
        per_token.push_back({{"text", whisper_token_to_str(ctx, token)}, {"logProbability", probability}});
        if (i < text_tokens.size())
            require(whisper_decode(ctx, &token, 1, 4 + i, 4) == 0, "Decoder failed");
    }
    return {{"text", text}, {"sumLogProbability", total},
            {"meanLogProbability", total / (count + 1)}, {"tokens", per_token}};
}

static void encode(whisper_context *ctx, const std::vector<float> &samples) {
    require(whisper_pcm_to_mel(ctx, samples.data(), samples.size(), 4) == 0, "Mel extraction failed");
    require(whisper_encode(ctx, 0, 4) == 0, "Encoder failed");
}

int main() {
    try {
        json input;
        std::cin >> input;
        require(input.at("version").get<int>() == 1, "Unsupported request version");
        const auto cases = input.at("cases");
        require(cases.is_array() && !cases.empty() && cases.size() <= 100, "Case count limit");
        auto params = whisper_context_default_params();
        params.use_gpu = input.value("useGpu", true);
        Context ctx(whisper_init_from_file_with_params(input.at("model").get<std::string>().c_str(), params), whisper_free);
        require(ctx != nullptr, "Model initialization failed");
        json output = {{"version", 1}, {"provider", "whisper-contrastive-experiment-v1"}, {"cases", json::array()}};
        for (const auto &item : cases) {
            const auto samples = pcm(item.at("pcmPath"));
            const auto candidates = item.at("candidates");
            require(candidates.is_array() && candidates.size() >= 2 && candidates.size() <= 12, "Alternative count limit");
            auto decode = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
            decode.n_threads = 4;
            decode.language = "en";
            decode.translate = false;
            decode.no_context = true;
            decode.no_timestamps = true;
            decode.print_realtime = false;
            decode.print_progress = false;
            decode.print_timestamps = false;
            decode.print_special = false;
            decode.temperature = 0;
            decode.temperature_inc = 0;
            decode.beam_search.beam_size = 5;
            // No initial_prompt, grammar, previous transcript, or script.
            require(whisper_full(ctx.get(), decode, samples.data(), samples.size()) == 0, "Unprompted recognition failed");
            std::string independent;
            for (int i = 0; i < whisper_full_n_segments(ctx.get()); ++i)
                independent += whisper_full_get_segment_text(ctx.get(), i);
            json result = {{"id", item.at("id")}, {"unprompted", independent}, {"audio", json::array()}, {"silence", json::array()}};
            encode(ctx.get(), samples);
            for (const auto &candidate : candidates) result["audio"].push_back(score(ctx.get(), candidate));
            encode(ctx.get(), std::vector<float>(samples.size(), 0));
            for (const auto &candidate : candidates) result["silence"].push_back(score(ctx.get(), candidate));
            output["cases"].push_back(result);
        }
        std::cout << output.dump() << std::endl;
    } catch (const std::exception &error) {
        std::cerr << "Acoustic comparison failed: " << error.what() << std::endl;
        return 1;
    }
}
