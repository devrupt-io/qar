#!/bin/bash
# Qar post-remove script
# Cleans up after package removal. Preserves user data in /qar/.
set -e

# On upgrade, skip the removal message
# RPM: $1 = number of remaining versions (0 = full remove, >= 1 = upgrade)
# Debian: $1 = "remove" or "upgrade"
if [ "$1" = "upgrade" ] || [ "$1" -ge 1 ] 2>/dev/null; then
  exit 0
fi

echo ""
echo "Qar has been removed."
echo ""
echo "Note: User data in /qar/ and configuration in /etc/qar/"
echo "have been preserved. Remove them manually if no longer needed:"
echo "  sudo rm -rf /qar /etc/qar"
echo ""
