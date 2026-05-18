@echo off
netsh advfirewall firewall delete rule name="WeddingSnap Server" >nul 2>&1
netsh advfirewall firewall add rule ^
name="WeddingSnap Server" ^
dir=in action=allow protocol=TCP localport=3000 ^
description="WeddingSnap local photo sharing server"
echo WeddingSnap firewall rule added.