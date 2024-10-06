import simpleGit from 'simple-git'
import cd from 'shelljs'
import fs from 'fs'
import path from 'path'
import { google } from 'googleapis'
import fetch from 'node-fetch'
import { readFileSync } from 'node:fs'
import process from 'process'
import { CronJob } from 'cron'
import dotenv from "dotenv"
import events from "events"
const clearModule = require('clear-module');

dotenv.config();

// change current directory to repo directory in local
const workingDir = process.cwd();
const REPO_NAME = process.env.REPO_NAME;
const isLocalStrategy = process.env.STRATEGY === "LOCAL";

console.log(`Working directory: ${workingDir} Local strategy: ${isLocalStrategy}`)
const repoBaseDir = `${workingDir}${path.sep}RemoteRepo`
const repoDir = `${repoBaseDir}${path.sep}${REPO_NAME}`
const episodeFile = isLocalStrategy ? `${workingDir}${path.sep}/episode.json` : `${repoDir}${path.sep}episode.json`;

// Repo name
const REPO = `${process.env.REPO_URL}`;  //Repo name
// User name and password of your GitHub
const USER = `${process.env.REPO_USER}`;
const PASS = `${process.env.REPO_PASSWORD}`;

const remote = `https://${USER}:${PASS}@${REPO}`;
const CHECK_INTERVAL = 3600;

export const eventEmitter = new events.EventEmitter();

function changeDir(dir) {
   console.log(`Changing working directory: ${dir}`)
   cd.cd(dir);
}

async function setUserName() {
   changeDir(repoDir)
   await simpleGit()
      .addConfig('user.name', process.env.GIT_USERNAME)
      .addConfig('user.email', process.env.GIT_EMAIL);
   changeDir(workingDir)
}

async function setupGit() {

   if (!fs.existsSync(repoDir)) {
      console.log("Cloning repo...")
      changeDir(repoBaseDir)

      return simpleGit()
         .clone(remote)
         .then(async () => {
            console.log('Cloning finished.');
            await setUserName();
         })
         .catch((err) => {
            console.error('Cloning failed: ', err);
            changeDir(workingDir)
         });
   } else {
      console.log("Git repo already exists.")
      await setUserName();
   }
}

async function commitChanges() {
   changeDir(repoDir)
   return simpleGit()
      .init()
      .add(episodeFile)
      .commit("set new youtube video id")
      .then(() => {
         console.log("Commit finished");
         changeDir(workingDir)
      }).catch((err) => {
         console.error('Commit failed: ', err);
         changeDir(workingDir)
      });
}

async function pushCommits() {
   changeDir(repoDir);
   return simpleGit()
      .init()
      .push(['-u', 'origin', 'main'], () => console.log('Pushing done.'))
      .then(() => {
         console.log("Pushing successful.");
         changeDir(workingDir)
      })
      .catch((err) => {
         console.error("Pushing failed: ", err);
         changeDir(workingDir);
      })
}

async function checkIsShort(videoId) {
   const res = await fetch(`https://www.youtube.com/shorts/${videoId}`);
   return res.url.startsWith("https://www.youtube.com/shorts/");
}

async function checkIsVideoNotBroadcast(youtube, videoId) {
   const data = await youtube.videos.list({
      part: 'snippet',
      id: videoId
   }).catch(err => {
      console.error(`Couldn't check video for live ${videoId}`, err);
   });

   if (data != undefined) {
      const items = data["data"]["items"];
      if (items.length > 0) {
         const video = items[0];
         const liveBroadcastContent = video["snippet"]["liveBroadcastContent"];
         return liveBroadcastContent == undefined || liveBroadcastContent == "none";
      }
   } else {
      throw Error("Failed to check if is live")
   }

   return false;
}

async function notifyUserForNewEpisode() {

}

function pushVideo(videoId, videoData, borderVideoId) {
   console.log(`Pushing video ${videoId} - file: ${episodeFile}`)

   fs.writeFile(episodeFile, JSON.stringify({ "id": videoId }), async (error) => {
      if (error) {
         console.log('An error has occurred saving episode', error);
         return;
      }

      if (!isLocalStrategy) {
         await commitChanges();
         await pushCommits();
      } else {
         clearModule("youtube-to-anchorfm/src/index.js"); // to trigger main at Y2S again
         import("youtube-to-anchorfm/src/index.js");
      }

      fs.writeFile('./youtube_data.json', JSON.stringify({
         date: new Date(),
         lastVideoId: videoId,
         borderVideoId: borderVideoId
      }, null, 2), error => {
         if (error) {
            console.log('An error has occurred saving data', error);
            return;
         }

         eventEmitter.emit('YouTubeVideoPushed', videoData)
         console.log('Changes pushed and saved.');
      })
   });

}

async function checkVideos() {
   console.log(`Checking videos... ${new Date().toLocaleString()}`)
   const buffer = readFileSync('./youtube_data.json');
   let data = buffer.length > 0 ? JSON.parse(buffer) : {};

   const borderVideoId = data["borderVideoId"];
   if (borderVideoId == undefined) {
      console.log("Value borderVideoId not defined. Aborting...");
      return
   }

   let lastDate = new Date(data["date"] || null);

   const secs = (new Date() - lastDate) / 1000;
   if (secs < CHECK_INTERVAL) {
      console.log(`Last check was ${secs} second(s) ago. Aborting...`);
      return
   }

   // Each API may support multiple versions. With this sample, we're getting
   // v3 of the blogger API, and using an API key to authenticate.
   const youtube = google.youtube({
      version: 'v3',
      auth: process.env.YOUTUBE_API_KEY
   });

   const params = {
      playlistId: 'UU31diBQ4Fg8_2uVUTvP7Jjg',
      part: 'snippet',
      maxResults: 20,
   };

   const lastVideoConst = data["lastVideoId"];
   let lastVideoId = lastVideoConst;

   // retrieve videos 
   youtube.playlistItems.list(params, async (err, res) => {
      if (err) {
         console.error(err);
         throw err;
      }

      let lastFilteredVideo;
      let lastFiltered;
      let firstValid;
      let foundLast = false;
      const len = res.data.items.length;
      for (let i = 0; i < len; i++) {
         const video = res.data.items[i];
         const snipped = video["snippet"]
         const resourceId = snipped["resourceId"]
         const videoId = resourceId["videoId"];
         const videoTitle = snipped["title"];

         console.log(`Checking video ${videoId} - ${videoTitle}`)
         try {
            if (!(await checkIsVideoNotBroadcast(youtube, videoId))) {
               console.log("Is livestream. Ignore.")
               continue;
            }
         } catch (ex) {
            console.error("Failed to check for livestream", ex);
            break
         }

         const isShort = await checkIsShort(videoId);
         if (isShort) {
            console.log("Is short. Ignore.");
            continue;
         }

         if (firstValid == undefined) {
            firstValid = i;
         }

         if (!foundLast && videoId == lastVideoConst) {
            foundLast = true;
         }

         if ((lastVideoId == videoId || borderVideoId == videoId) || i == (len - 1)) { // reached end or need to reset end (for example if end video got deleted)
            // upload this video
            if (lastVideoId == videoId || borderVideoId == videoId) {
               if (lastFiltered == undefined) {
                  console.log(`No new video found. Index: ${i}`);
                  break
               }

               lastVideoId = lastFiltered; // reached

            } else {
               lastVideoId = videoId; // reset
               lastFilteredVideo = video;
            }

            if (lastFilteredVideo == undefined) {
               throw new Error("Last filteredVideo was undefined.");
            }

            pushVideo(lastVideoId, lastFilteredVideo, borderVideoId);
            return;
         } else {
            // go until we find last vid
            lastFiltered = videoId;
            lastFilteredVideo = video;
         }
      }

      if (!foundLast && firstValid != undefined) {
         console.log("Couldn't find last pushed video. Probably deleted or not public. Pushing last valid instead.")
         const video = res.data.items[firstValid];
         const snipped = video["snippet"]
         const resourceId = snipped["resourceId"]
         const videoId = resourceId["videoId"];
         pushVideo(videoId, video, borderVideoId);
      }
   });
}

let cronMidnight;
async function scheduleCronJob() {
   if (cronMidnight != undefined) {
      console.log("YouTube cronjob already scheduled.")
      return
   }

   await checkVideos();

   cronMidnight = new CronJob('0 */2 * * *', async function () {
      await checkVideos()
   },
      null,
      true);

   console.log(`YouTube cronjob scheduled. Next execution: ${new Date(cronMidnight.nextDate())}`)
}

export async function setupYouTubeToSpotify() {
   console.log("Starting YouTube to Spotify...");

   if (!isLocalStrategy) {
      await setupGit();
   }

   await scheduleCronJob();
   console.log("YouTube to Spotify Started.")
}