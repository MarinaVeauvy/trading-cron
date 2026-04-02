@echo off
cd /d C:\Users\marin\Documents\trading-cron
node scrape-full.js >> scraper-log.txt 2>&1
echo [%date% %time%] Scraper executado >> scraper-log.txt
