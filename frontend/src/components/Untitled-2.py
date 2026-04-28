import requests                                                                                                                                                        
import urllib3                                                                                                                                                         
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                                            
base = "https://10.62.164.143/api/v3.7"

# Authenticate first
auth = requests.post(f"{base}/sessions", json={
    "username": "cwdavis",
    "password": "V#per$$84-V#per$$84"
}, verify=False)
token = auth.json()["session"]
headers = {"Authorization": f"Token {token}"}

# Probe all known and guessed endpoint paths
paths = [
    # From v3.4 RAML spec
    "templates", "templates/push",
    "tags", "ports", "system", "licenses", "bundles",
    "groups", "users", "interfaces", "search",
    "dependent_lighthouses", "netops_modules", "snmp",
    "console_gateway", "actions",
    # Template variations
    "script_templates", "config_templates",
    "configuration_templates", "configuration/templates",
    "configuration/script_templates",
    "configTemplates", "scriptTemplates",
    # Newer possible paths
    "profiles", "config_profiles", "configuration_profiles",
    "config", "configuration",
    "template_push", "push", "config_push",
    # NOM/Automation Gateway
    "nom/ag/devices", "nom/ag/auth_tokens",
    # Other guesses
    "firmware", "jobs", "tasks", "audit",
    "enrollment", "enrollment_bundles",
]

print(f"{'Endpoint':<45} {'Status':<8} {'Size'}")
print("-" * 70)
for path in sorted(set(paths)):
    try:
        resp = requests.get(f"{base}/{path}", headers=headers, verify=False, timeout=5)
        marker = " <-- ***" if resp.status_code == 200 else ""
        print(f"/{path:<44} {resp.status_code:<8} {len(resp.content)}B{marker}")
    except Exception as e:
        print(f"/{path:<44} ERROR    {e}")
