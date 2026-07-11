#!/usr/bin/env python3
"""API contract tests for persisted per-step model configuration."""

import os
import sys

import requests


BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')
VALID_STEP_MODELS = {"claude": {"brief": "claude-opus-4-8"}}


def report(results: list[tuple[str, bool]], name: str, passed: bool, detail: str = "") -> None:
    status = "✓" if passed else "✗"
    suffix = f": {detail}" if detail else ""
    print(f"{status} {name}{suffix}")
    results.append((name, passed))


def put_step_models(value: object) -> requests.Response:
    return requests.put(
        f"{BASE_URL}/api/config/settings/stepModels",
        json={"value": value},
    )


def test_model_config() -> bool:
    results: list[tuple[str, bool]] = []
    original_value: object | None = None

    try:
        initial_response = requests.get(f"{BASE_URL}/api/config/settings/stepModels")
        if initial_response.status_code != 200:
            report(results, "GET initial stepModels", False, str(initial_response.status_code))
            return False

        initial_body = initial_response.json()
        original_value = initial_body.get("value")
        report(results, "GET initial stepModels", True)

        valid_response = put_step_models(VALID_STEP_MODELS)
        report(results, "PUT valid stepModels", valid_response.status_code == 200, str(valid_response.status_code))

        round_trip_response = requests.get(f"{BASE_URL}/api/config/settings/stepModels")
        round_trip_ok = (
            round_trip_response.status_code == 200
            and round_trip_response.json().get("value") == VALID_STEP_MODELS
        )
        report(results, "GET stepModels round-trip", round_trip_ok, str(round_trip_response.status_code))

        invalid_cases = [
            ("reject unsupported agent", {"gemini": {"brief": "model"}}),
            ("reject unsupported step", {"claude": {"verify": "model"}}),
            ("reject non-string model", {"claude": {"brief": 42}}),
        ]
        for name, value in invalid_cases:
            response = put_step_models(value)
            report(results, name, response.status_code == 400, str(response.status_code))

        models_response = requests.get(f"{BASE_URL}/api/models")
        models_ok = False
        if models_response.status_code == 200:
            models_body = models_response.json()
            models = models_body.get("models")
            agent_type = models_body.get("agentType")
            first_model = models[0] if isinstance(models, list) and models else None
            models_ok = (
                agent_type in {"claude", "copilot", "opencode"}
                and isinstance(models, list)
                and len(models) > 0
                and isinstance(first_model, dict)
                and first_model.get("id") == ""
                and all(
                    isinstance(model.get("id"), str) and isinstance(model.get("label"), str)
                    for model in models
                    if isinstance(model, dict)
                )
                and all(isinstance(model, dict) for model in models)
            )
        report(results, "GET /api/models catalog", models_ok, str(models_response.status_code))
    except requests.RequestException as error:
        report(results, "model configuration API request", False, str(error))
    finally:
        if original_value is not None:
            try:
                restore_response = put_step_models(original_value)
                report(results, "restore original stepModels", restore_response.status_code == 200, str(restore_response.status_code))
            except requests.RequestException as error:
                report(results, "restore original stepModels", False, str(error))

    passed = sum(1 for _, result in results if result)
    print(f"\nModel configuration tests: {passed}/{len(results)} passed")
    return all(result for _, result in results)


if __name__ == '__main__':
    sys.exit(0 if test_model_config() else 1)
