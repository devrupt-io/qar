#!/bin/bash
# Qar post-remove script
# Cleans up after package removal. Preserves user data in /qar/.
set -e

echo ""
echo "Qar has been removed."
echo ""
echo "Note: User data in /qar/ and configuration in /etc/qar/"
echo "have been preserved. Remove them manually if no longer needed:"
echo "  sudo rm -rf /qar /etc/qar"
echo ""
