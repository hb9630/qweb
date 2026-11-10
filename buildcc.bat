@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set K=C:\Program Files (x86)\Windows Kits\10
set INCLUDE=%INCLUDE%;%K%\Include\10.0.19041.0\ucrt;%K%\Include\10.0.19041.0\um;%K%\Include\10.0.19041.0\shared;%K%\Include\10.0.19041.0\winrt;%K%\Include\10.0.19041.0\cppwinrt
set LIB=%LIB%;%K%\Lib\10.0.19041.0\ucrt\x64;%K%\Lib\10.0.19041.0\um\x64
cd /d C:\Users\cnhua\ccweb\backend && cargo build --release -p qweb-server %*
