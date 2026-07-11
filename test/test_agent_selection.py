#!/usr/bin/env python3
"""API contract tests for agent provider selection and availability."""

import os
import sys

import requests


BASE_URL = os.environ.get('FORMIC_URL', 'http://localhost:8000')


def report(results: list[tuple[str, bool]], name: str, passed: bool, detail: str = "") -> None:
    status = "✓" if passed else "✗"
    suffix = f": {detail}" if detail else ""
    print(f"{status} {name}{suffix}")
    results.append((name, passed))


def put_agent_type(value: str) -> requests.Response:
    return requests.put(
        f"{BASE_URL}/api/config/settings/agentType",
        json={"value": value},
    )


def test_agent_selection() -> bool:
    results: list[tuple[str, bool]] = []
    original_value: str | None = None

    try:
        # 1. GET the initial agentType setting
        initial_response = requests.get(f"{BASE_URL}/api/config/settings/agentType")
        if initial_response.status_code != 200:
            report(results, "GET initial agentType", False, str(initial_response.status_code))
            return False

        initial_body = initial_response.json()
        original_value = initial_body.get("value")
        report(results, "GET initial agentType", True, str(original_value))

        # 2. PUT valid copilot
        valid_response = put_agent_type("copilot")
        report(results, "PUT agentType=copilot", valid_response.status_code == 200, str(valid_response.status_code))

        # 3. GET /api/models reflects the new agentType
        models_response = requests.get(f"{BASE_URL}/api/models")
        models_ok = (
            models_response.status_code == 200
            and models_response.json().get("agentType") == "copilot"
        )
        report(results, "GET /api/models agentType=copilot", models_ok, str(models_response.status_code))

        # 4. PUT invalid value returns 400
        invalid_response = put_agent_type("gpt-cli")
        report(results, "PUT invalid agentType returns 400", invalid_response.status_code == 400, str(invalid_response.status_code))

        # 5. PUT another invalid value
        invalid2_response = put_agent_type("")
        report(results, "PUT empty agentType returns 400", invalid2_response.status_code == 400, str(invalid2_response.status_code))

        # 6. PUT valid opencode
        opencode_response = put_agent_type("opencode")
        report(results, "PUT agentType=opencode", opencode_response.status_code == 200, str(opencode_response.status_code))

        # 7. GET /api/models reflects opencode
        models2_response = requests.get(f"{BASE_URL}/api/models")
        models2_ok = (
            models2_response.status_code == 200
            and models2_response.json().get("agentType") == "opencode"
        )
        report(results, "GET /api/models agentType=opencode", models2_ok, str(models2_response.status_code))

        # 8. GET /api/agents returns current + 3-agent array
        agents_response = requests.get(f"{BASE_URL}/api/agents")
        agents_ok = False
        if agents_response.status_code == 200:
            body = agents_response.json()
            current = body.get("current")
            agents = body.get("agents")
            agents_ok = (
                current == "opencode"
                and isinstance(agents, list)
                and len(agents) == 3
                and all(
                    isinstance(a.get("type"), str)
                    and isinstance(a.get("displayName"), str)
                    and isinstance(a.get("installed"), bool)
                    for a in agents
                )
            )
        report(results, "GET /api/agents structure", agents_ok, str(agents_response.status_code))

        # 9. GET /api/agents?refresh=1 bypasses cache
        refresh_response = requests.get(f"{BASE_URL}/api/agents?refresh=1")
        refresh_ok = (
            refresh_response.status_code == 200
            and isinstance(refresh_response.json().get("agents"), list)
            and len(refresh_response.json().get("agents", [])) == 3
        )
        report(results, "GET /api/agents?refresh=1", refresh_ok, str(refresh_response.status_code))

        # 10. PUT claude and verify models reflect it
        claude_response = put_agent_type("claude")
        report(results, "PUT agentType=claude", claude_response.status_code == 200, str(claude_response.status_code))

        models3_response = requests.get(f"{BASE_URL}/api/models")
        models3_ok = (
            models3_response.status_code == 200
            and models3_response.json().get("agentType") == "claude"
        )
        report(results, "GET /api/models agentType=claude", models3_ok, str(models3_response.status_code))

    except requests.RequestException as error:
        report(results, "agent selection API request", False, str(error))
    finally:
        # Restore original value
        if original_value is not None:
            try:
                restore_response = put_agent_type(original_value)
                report(results, "restore original agentType", restore_response.status_code == 200, str(restore_response.status_code))
            except requests.RequestException as error:
                report(results, "restore original agentType", False, str(error))

    passed = sum(1 for _, result in results if result)
    print(f"\nAgent selection tests: {passed}/{len(results)} passed")
    return all(result for _, result in results)


if __name__ == '__main__':
    sys.exit(0 if test_agent_selection() else 1)
