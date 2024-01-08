// Simple-git without promise 
import simpleGit from 'simple-git'
// Shelljs package for running shell tasks optional
import cd from 'shelljs'
// Simple Git with Promise for handling success and failure
// import {simpleGitPromise} from '@simple-git/promise'
import fs from 'fs'
import path from 'path'
import { google } from 'googleapis'
import fetch from 'node-fetch'
import { readFileSync } from 'node:fs'
import process from 'process'
import { CronJob } from 'cron'
import dotenv from "dotenv"
import events from "events"

dotenv.config();

// change current directory to repo directory in local
const workingDir = process.cwd();
const REPO_NAME = `${process.env.REPO_NAME}`

const repoBaseDir = `${workingDir}${path.sep}RemoteRepo`
const repoDir = `${repoBaseDir}${path.sep}${REPO_NAME}`
const episodeFile = `${repoDir}${path.sep}episode.json`;

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

   let lastVideoId = data["lastVideoId"];

   // retrieve videos 
   youtube.playlistItems.list(params, async (err, res) => {
      if (err) {
         console.error(err);
         throw err;
      }

      let lastFilteredVideo;
      let lastFiltered;
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

            console.log(`Pushing video ${lastVideoId} (${videoId}, ${lastFiltered})`)

            lastDate = new Date();
            data["date"] = lastDate;
            data["lastVideoId"] = lastVideoId;

            fs.writeFile(episodeFile, JSON.stringify({ "id": lastVideoId }), async (error) => {
               if (error) {
                  console.log('An error has occurred saving episode', error);
                  return;
               }

               await commitChanges();
               await pushCommits();

               fs.writeFile('./youtube_data.json', JSON.stringify(data, null, 2), error => {
                  if (error) {
                     console.log('An error has occurred saving data', error);
                     return;
                  }

                  eventEmitter.emit('YouTubeVideoPushed', lastFilteredVideo)
                  console.log('Changes pushed and saved.');
               })
            });

            break;
         } else {
            // go until we find last vid
            lastFiltered = videoId;
            lastFilteredVideo = video;
         }
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
   console.log("Starting...")
   await setupGit();
   await scheduleCronJob();
   console.log("Started.")
}

